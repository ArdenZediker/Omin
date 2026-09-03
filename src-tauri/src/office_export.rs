//! Office 文档导出：手写 OOXML（docx / xlsx / pptx），仅依赖 zip + serde_json + regex。
//!
//! - export_docx：标题层级 / 段落（支持 **加粗** 内联）/ 项目符号 / 编号 / 分页 / 表格
//! - export_xlsx：多工作表 / 内联字符串 / 数字 / 公式（打开时强制重算）/ 表头样式
//! - export_pptx：16:9 幻灯片（标题 + 要点列表）
//!
//! spec 通过 JSON 字符串传入（模型工具调用的对象参数），路径写入前校验扩展名，
//! 已存在文件默认拒绝覆盖（overwrite=true 才允许）。

use serde_json::Value;
use std::io::{BufWriter, Write};
use std::path::Path;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

// ---------- 通用工具 ----------

fn esc_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 0→A, 25→Z, 26→AA（xlsx 列号）。
fn col_name(mut idx: usize) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b'A' + (idx % 26) as u8);
        if idx < 26 {
            break;
        }
        idx = idx / 26 - 1;
    }
    out.reverse();
    String::from_utf8(out).expect("ASCII 列名")
}

/// AI 禁止写入的系统/密钥目录：.ssh、AppData、Windows/System32、Program Files、ProgramData。
/// 系统临时目录（TEMP/TMP，含单测所在 AppData\Local\Temp）放行，避免误伤中转与测试。
fn no_go_zone(path: &Path) -> Option<&'static str> {
    let lower = path.to_string_lossy().replace('\\', "/").to_lowercase();
    for var in ["TEMP", "TMP", "TMPDIR"] {
        if let Ok(t) = std::env::var(var) {
            let t = t.replace('\\', "/").to_lowercase().trim_end_matches('/').to_string();
            if !t.is_empty() && (lower == t || lower.starts_with(&format!("{t}/"))) {
                return None;
            }
        }
    }
    let windir = std::env::var("WINDIR")
        .unwrap_or_else(|_| "C:\\Windows".into())
        .replace('\\', "/")
        .to_lowercase();
    let systemroot = std::env::var("SYSTEMROOT")
        .unwrap_or_else(|_| windir.clone())
        .replace('\\', "/")
        .to_lowercase();
    let systemdrive = std::env::var("SYSTEMDRIVE")
        .unwrap_or_else(|_| "C:".into())
        .to_lowercase();
    let mut forbidden: Vec<String> = vec![
        format!("{windir}/"),
        format!("{systemroot}/"),
        format!("{systemdrive}/program files/"),
        format!("{systemdrive}/program files (x86)/"),
        format!("{systemdrive}/programdata/"),
    ];
    if let Ok(up) = std::env::var("USERPROFILE") {
        let up = up.replace('\\', "/").to_lowercase();
        forbidden.push(format!("{up}/.ssh/"));
        forbidden.push(format!("{up}/appdata/"));
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = home.replace('\\', "/").to_lowercase();
        forbidden.push(format!("{home}/.ssh/"));
    }
    for f in &forbidden {
        if lower.starts_with(f) {
            return Some("系统目录或密钥目录（.ssh / AppData / Windows / Program Files）");
        }
    }
    None
}

/// child 是否落在 parent 之内（大小写不敏感，统一 / 分隔符，避免对不存在路径 canonicalize 失败）。
fn is_within(child: &Path, parent: &Path) -> bool {
    let c = child.to_string_lossy().replace('\\', "/").to_lowercase();
    let p = parent
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
        .trim_end_matches('/')
        .to_string();
    c == p || c.starts_with(&format!("{p}/"))
}

fn check_path(
    path: &str,
    expected_exts: &[&str],
    overwrite: bool,
    workspace_path: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("输出路径不能为空".to_string());
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() {
        return Err(format!(
            "输出路径必须是绝对路径（收到「{trimmed}」）。请使用如 C:/Users/<name>/Documents/xxx.docx 的真实本机路径，不要使用 sandbox:/ 等虚拟路径"
        ));
    }
    // 兜底 No-Go Zones：AI 绝不应写入系统/密钥目录（即使前端已放行也拒绝）。
    if let Some(zone) = no_go_zone(p) {
        return Err(format!(
            "输出路径位于禁止写入的{zone}，已拒绝。请改用项目工作区或文档目录。"
        ));
    }
    // 兜底工作区围栏：项目会话下越界写入一律拒绝（前端会先走提权确认）。
    if let Some(ws) = workspace_path {
        let ws = ws.trim();
        if !ws.is_empty() && !is_within(p, Path::new(ws)) {
            return Err(format!(
                "输出路径必须位于项目工作区内（收到「{trimmed}」）。请使用相对路径或仅提供文件名，文件将保存到项目目录 {ws}。"
            ));
        }
    }
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !expected_exts.contains(&ext.as_str()) {
        return Err(format!(
            "输出文件扩展名必须是 {}（收到「{ext}」）",
            expected_exts.join(" / ")
        ));
    }
    if p.exists() && !overwrite {
        return Err(format!("文件已存在：{trimmed}（如需覆盖请传 overwrite=true）"));
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建输出目录失败: {e}"))?;
        }
    }
    Ok(p.to_path_buf())
}

fn write_zip(
    path: &std::path::Path,
    entries: Vec<(String, String)>,
) -> Result<u64, String> {
    let file = std::fs::File::create(path).map_err(|e| format!("创建文件失败: {e}"))?;
    let mut writer = ZipWriter::new(BufWriter::new(file));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, content) in &entries {
        writer
            .start_file(name.as_str(), options)
            .map_err(|e| format!("写入 zip 条目 {name} 失败: {e}"))?;
        writer
            .write_all(content.as_bytes())
            .map_err(|e| format!("写入条目 {name} 内容失败: {e}"))?;
    }
    writer.finish().map_err(|e| format!("收尾 zip 失败: {e}"))?;
    let size = std::fs::metadata(path).map_err(|e| format!("读取文件元数据失败: {e}"))?.len();
    Ok(size)
}

fn parse_spec(spec_json: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(spec_json.trim())
        .map_err(|e| format!("spec 不是合法 JSON：{e}"))?;
    if !v.is_object() {
        return Err("spec 必须是 JSON 对象".to_string());
    }
    Ok(v)
}

fn obj_array<'a>(v: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    v.get(key).and_then(Value::as_array)
}

// ---------- DOCX ----------

/// 段落文本 → run 序列，支持 **加粗** 内联语法。
fn docx_runs(text: &str, base_bold: bool, sz: u32) -> String {
    let mut runs = String::new();
    for (idx, part) in text.split("**").enumerate() {
        if part.is_empty() {
            continue;
        }
        let bold = base_bold || idx % 2 == 1;
        let bold_xml = if bold { "<w:b/><w:bCs/>" } else { "" };
        runs.push_str(&format!(
            "<w:r><w:rPr>{bold_xml}<w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/></w:rPr>\
             <w:t xml:space=\"preserve\">{}</w:t></w:r>",
            esc_xml(part)
        ));
    }
    if runs.is_empty() {
        runs = "<w:r><w:t xml:space=\"preserve\"></w:t></w:r>".to_string();
    }
    runs
}

fn docx_paragraph(
    text: &str,
    heading: Option<u8>,
    align: Option<&str>,
    indent_bullet: bool,
) -> String {
    let (sz, bold, outline) = match heading {
        Some(1) => (32, true, Some(0u8)),
        Some(2) => (28, true, Some(1)),
        Some(3) => (24, true, Some(2)),
        _ => (22, false, None),
    };
    let mut ppr = String::new();
    match heading {
        Some(_) => ppr.push_str("<w:spacing w:before=\"240\" w:after=\"120\"/>"),
        None => ppr.push_str("<w:spacing w:after=\"120\"/>"),
    }
    if let Some(level) = outline {
        ppr.push_str(&format!("<w:outlineLvl w:val=\"{level}\"/>"));
    }
    if let Some(a) = align {
        ppr.push_str(&format!("<w:jc w:val=\"{}\"/>", esc_xml(a)));
    }
    if indent_bullet {
        ppr.push_str("<w:ind w:left=\"360\" w:hanging=\"360\"/>");
    }
    format!("<w:p><w:pPr>{ppr}</w:pPr>{}</w:p>", docx_runs(text, bold, sz))
}

fn docx_table(rows: &[Value], header: bool) -> Result<String, String> {
    if rows.is_empty() {
        return Err("表格 rows 不能为空".to_string());
    }
    let border =
        "<w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9CA3AF\"/>\
         <w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9CA3AF\"/>\
         <w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9CA3AF\"/>\
         <w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9CA3AF\"/>\
         <w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9CA3AF\"/>\
         <w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"9CA3AF\"/>";
    let col_count = rows.iter().filter_map(Value::as_array).map(Vec::len).max().unwrap_or(1);
    let mut grid = String::new();
    for _ in 0..col_count {
        grid.push_str("<w:gridCol w:w=\"2400\"/>");
    }
    let mut trs = String::new();
    for (r_idx, row) in rows.iter().enumerate() {
        let cells = row
            .as_array()
            .ok_or_else(|| format!("表格第 {} 行不是数组", r_idx + 1))?;
        let is_header_row = header && r_idx == 0;
        let mut tcs = String::new();
        for cell in cells {
            let text = match cell {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let shd = if is_header_row {
                "<w:shd w:val=\"clear\" w:fill=\"D9E1F2\"/>"
            } else {
                ""
            };
            tcs.push_str(&format!(
                "<w:tc><w:tcPr>{shd}</w:tcPr>{}</w:tc>",
                docx_paragraph(&text, None, None, false)
            ));
        }
        trs.push_str(&format!("<w:tr>{tcs}</w:tr>"));
    }
    Ok(format!(
        "<w:tbl><w:tblPr><w:tblBorders>{border}</w:tblBorders><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr>\
         <w:tblGrid>{grid}</w:tblGrid>{trs}</w:tbl>"
    ))
}

fn build_docx(spec: &Value) -> Result<Vec<(String, String)>, String> {
    let children = obj_array(spec, "children")
        .ok_or("spec.children 缺失：应为块级元素数组（h1/h2/h3/p/bullet/number/pagebreak/table）")?;
    let mut body = String::new();
    let mut number_counter = 0u32;

    if let Some(title) = spec.get("title").and_then(Value::as_str) {
        body.push_str(&docx_paragraph(title, Some(1), None, false));
    }
    for (idx, block) in children.iter().enumerate() {
        let kind = block
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("children[{idx}] 缺少 type 字段"))?;
        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
        match kind {
            "h1" => body.push_str(&docx_paragraph(text, Some(1), None, false)),
            "h2" => body.push_str(&docx_paragraph(text, Some(2), None, false)),
            "h3" => body.push_str(&docx_paragraph(text, Some(3), None, false)),
            "p" => {
                let align = block.get("align").and_then(Value::as_str);
                body.push_str(&docx_paragraph(text, None, align, false));
            }
            "bullet" => {
                let t = format!("• {text}");
                body.push_str(&docx_paragraph(&t, None, None, true));
            }
            "number" => {
                number_counter += 1;
                let t = format!("{number_counter}. {text}");
                body.push_str(&docx_paragraph(&t, None, None, true));
            }
            "pagebreak" => body.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>"),
            "table" => {
                let rows = block
                    .get("rows")
                    .and_then(Value::as_array)
                    .ok_or_else(|| format!("children[{idx}] table 缺少 rows"))?;
                let header = block.get("header").and_then(Value::as_bool).unwrap_or(true);
                body.push_str(&docx_table(rows, header)?);
                body.push_str("<w:p/>");
            }
            other => return Err(format!("children[{idx}] 未知类型「{other}」（支持 h1/h2/h3/p/bullet/number/pagebreak/table）")),
        }
    }
    if body.is_empty() {
        return Err("文档内容为空：至少提供一个块级元素".to_string());
    }
    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
         <w:body>{body}\
         <w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>\
         <w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"851\" w:footer=\"992\" w:gutter=\"0\"/>\
         </w:sectPr></w:body></w:document>"
    );
    Ok(vec![
        (
            "[Content_Types].xml".to_string(),
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
             <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
             <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
             <Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
             </Types>"
                .to_string(),
        ),
        (
            "_rels/.rels".to_string(),
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
             <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
             </Relationships>"
                .to_string(),
        ),
        ("word/document.xml".to_string(), document),
    ])
}

// ---------- XLSX ----------

fn xlsx_cell(ref_: &str, cell: &Value) -> Result<String, String> {
    match cell {
        Value::Number(n) => Ok(format!("<c r=\"{ref_}\"><v>{n}</v></c>")),
        Value::String(s) => Ok(format!(
            "<c r=\"{ref_}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
            esc_xml(s)
        )),
        Value::Bool(b) => Ok(format!("<c r=\"{ref_}\" t=\"boolean\"><v>{}</v></c>", if *b { 1 } else { 0 })),
        Value::Object(o) => {
            let style_idx = match o.get("style").and_then(Value::as_str) {
                Some("bold") => Some(1),
                Some("header") => Some(2),
                Some(other) => return Err(format!("未知单元格样式「{other}」（支持 bold / header）")),
                None => None,
            };
            let s_attr = style_idx.map(|s| format!(" s=\"{s}\"")).unwrap_or_default();
            if let Some(f) = o.get("formula").and_then(Value::as_str) {
                return Ok(format!("<c r=\"{ref_}\"{s_attr}><f>{}</f></c>", esc_xml(f)));
            }
            if let Some(t) = o.get("text").and_then(Value::as_str) {
                return Ok(format!(
                    "<c r=\"{ref_}\" t=\"inlineStr\"{s_attr}><is><t xml:space=\"preserve\">{}</t></is></c>",
                    esc_xml(t)
                ));
            }
            Err("对象单元格需要 formula 或 text 字段".to_string())
        }
        Value::Null => Ok(String::new()),
        other => Err(format!("不支持的单元格类型：{other}")),
    }
}

fn build_xlsx(spec: &Value) -> Result<Vec<(String, String)>, String> {
    let sheets = obj_array(spec, "sheets").ok_or("spec.sheets 缺失：应为工作表数组")?;
    if sheets.is_empty() {
        return Err("至少需要一个工作表".to_string());
    }
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut sheet_decls = String::new();
    let mut wb_rels = String::new();
    let mut ct_overrides = String::new();

    for (idx, sheet) in sheets.iter().enumerate() {
        let n = idx + 1;
        let name = sheet
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Sheet{n}"));
        if name.len() > 31 || name.contains([':', '\\', '/', '?', '*', '[', ']']) {
            return Err(format!("工作表名「{name}」非法（≤31 字符，不含 :\\/?*[]）"));
        }
        let rows = obj_array(sheet, "rows").ok_or_else(|| format!("工作表「{name}」缺少 rows"))?;
        let mut sheet_xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>",
        );
        for (r_idx, row) in rows.iter().enumerate() {
            let cells = row
                .as_array()
                .ok_or_else(|| format!("工作表「{name}」第 {} 行不是数组", r_idx + 1))?;
            let mut row_xml = format!("<row r=\"{}\">", r_idx + 1);
            for (c_idx, cell) in cells.iter().enumerate() {
                let ref_ = format!("{}{}", col_name(c_idx), r_idx + 1);
                row_xml.push_str(&xlsx_cell(&ref_, cell)?);
            }
            row_xml.push_str("</row>");
            sheet_xml.push_str(&row_xml);
        }
        sheet_xml.push_str("</sheetData></worksheet>");
        entries.push((format!("xl/worksheets/sheet{n}.xml"), sheet_xml));
        sheet_decls.push_str(&format!(
            "<sheet name=\"{}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>",
            esc_xml(&name)
        ));
        wb_rels.push_str(&format!(
            "<Relationship Id=\"rId{n}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>"
        ));
        ct_overrides.push_str(&format!(
            "<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
        ));
    }
    let styles_rel_id = sheets.len() + 1;
    wb_rels.push_str(&format!(
        "<Relationship Id=\"rId{styles_rel_id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>"
    ));

    let styles = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
        <styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\
        <fonts count=\"2\">\
        <font><sz val=\"11\"/><name val=\"Calibri\"/></font>\
        <font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font>\
        </fonts>\
        <fills count=\"3\">\
        <fill><patternFill patternType=\"none\"/></fill>\
        <fill><patternFill patternType=\"gray125\"/></fill>\
        <fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFD9E1F2\"/><bgColor indexed=\"64\"/></patternFill></fill>\
        </fills>\
        <borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>\
        <cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>\
        <cellXfs count=\"3\">\
        <xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>\
        <xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/>\
        <xf numFmtId=\"0\" fontId=\"1\" fillId=\"2\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"1\"><alignment horizontal=\"center\" vertical=\"center\"/></xf>\
        </cellXfs>\
        <cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>\
        </styleSheet>";

    entries.push((
        "[Content_Types].xml".to_string(),
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
             <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
             <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
             <Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
             <Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>\
             {ct_overrides}</Types>"
        ),
    ));
    entries.push((
        "_rels/.rels".to_string(),
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>\
         </Relationships>"
            .to_string(),
    ));
    entries.push((
        "xl/workbook.xml".to_string(),
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" \
             xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">\
             <workbookPr/><sheets>{sheet_decls}</sheets>\
             <calcPr calcId=\"0\" fullCalcOnLoad=\"1\"/></workbook>"
        ),
    ));
    entries.push((
        "xl/_rels/workbook.xml.rels".to_string(),
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
             {wb_rels}</Relationships>"
        ),
    ));
    entries.push(("xl/styles.xml".to_string(), styles.to_string()));
    Ok(entries)
}

// ---------- PPTX ----------

const PPTX_W: i64 = 12192000; // 16:9
const PPTX_H: i64 = 6858000;

const PPTX_THEME: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Omni">
<a:themeElements>
<a:clrScheme name="Omni"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="7C3AED"/></a:accent2><a:accent3><a:srgbClr val="059669"/></a:accent3><a:accent4><a:srgbClr val="D97706"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="0D9488"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Omni"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Omni">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:alpha val="60000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:alpha val="30000"/></a:schemeClr></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"><a:alpha val="60000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="50800"><a:solidFill><a:schemeClr val="phClr"><a:alpha val="20000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="20000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="50000" dist="30000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="30000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:alpha val="60000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:alpha val="30000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme></a:themeElements></a:theme>"#;

const PPTX_SP_TREE_OPEN: &str = "<p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>";

fn pptx_text_sp(id: u32, name: &str, x: i64, y: i64, cx: i64, cy: i64, paras: &str, anchor: &str) -> String {
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
         <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>\
         <p:txBody><a:bodyPr wrap=\"square\" anchor=\"{anchor}\"/><a:lstStyle/>{paras}</p:txBody></p:sp>"
    )
}

fn pptx_run(text: &str, sz: u32, bold: bool, color: &str) -> String {
    let bold_attr = if bold { " b=\"1\"" } else { "" };
    format!(
        "<a:r><a:rPr lang=\"zh-CN\" sz=\"{sz}\"{bold_attr}><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r>",
        esc_xml(text)
    )
}

fn build_pptx(spec: &Value) -> Result<Vec<(String, String)>, String> {
    let slides = obj_array(spec, "slides").ok_or("spec.slides 缺失：应为幻灯片数组")?;
    if slides.is_empty() {
        return Err("至少需要一页幻灯片".to_string());
    }
    if slides.len() > 100 {
        return Err("幻灯片数量过多（上限 100 页）".to_string());
    }

    let mut entries: Vec<(String, String)> = Vec::new();
    let mut sld_ids = String::new();
    let mut pres_rels = String::from(
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>",
    );
    let mut ct_overrides = String::new();

    for (idx, slide) in slides.iter().enumerate() {
        let n = idx + 1;
        let sld_rid = idx + 2; // rId1 是 master
        let title = slide
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if title.is_empty() {
            return Err(format!("第 {n} 页幻灯片缺少 title"));
        }
        let bullets = slide
            .get("bullets")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("第 {n} 页幻灯片缺少 bullets 数组"))?;
        if bullets.len() > 20 {
            return Err(format!("第 {n} 页要点过多（上限 20 条）"));
        }

        let title_paras = format!("<a:p>{}</a:p>", pptx_run(title, 3200, true, "1F2937"));
        let mut body_paras = String::new();
        for bullet in bullets {
            let text = match bullet {
                Value::String(s) => s.clone(),
                Value::Object(o) => o
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                other => other.to_string(),
            };
            if text.trim().is_empty() {
                continue;
            }
            body_paras.push_str(&format!(
                "<a:p><a:pPr marL=\"285750\" indent=\"-285750\"><a:buFont typeface=\"Arial\"/><a:buChar char=\"•\"/></a:pPr>{}</a:p>",
                pptx_run(&text, 1800, false, "374151")
            ));
        }
        if body_paras.is_empty() {
            body_paras = "<a:p/>".to_string();
        }

        let slide_xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
             xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
             xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
             <p:cSld>{PPTX_SP_TREE_OPEN}\
             {}\
             {}\
             </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
            pptx_text_sp(2, "标题", 838200, 365760, PPTX_W - 1676400, 1000000, &title_paras, "ctr"),
            pptx_text_sp(3, "内容", 838200, 1645920, PPTX_W - 1676400, PPTX_H - 2213760, &body_paras, "t"),
        );
        entries.push((format!("ppt/slides/slide{n}.xml"), slide_xml));
        entries.push((
            format!("ppt/slides/_rels/slide{n}.xml.rels"),
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
             <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
             </Relationships>"
                .to_string(),
        ));
        sld_ids.push_str(&format!("<p:sldId id=\"{}\" r:id=\"rId{sld_rid}\"/>", 255 + n));
        pres_rels.push_str(&format!(
            "<Relationship Id=\"rId{sld_rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{n}.xml\"/>"
        ));
        ct_overrides.push_str(&format!(
            "<Override PartName=\"/ppt/slides/slide{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"
        ));
    }
    let theme_rid = slides.len() + 2;
    pres_rels.push_str(&format!(
        "<Relationship Id=\"rId{theme_rid}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/>"
    ));

    let master = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:sldMaster xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
         xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
         xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
         <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\
         {PPTX_SP_TREE_OPEN}</p:spTree></p:cSld>\
         <p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>\
         <p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst></p:sldMaster>"
    );
    let layout = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:sldLayout xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
         xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
         xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" type=\"blank\">\
         <p:cSld name=\"Blank\">{PPTX_SP_TREE_OPEN}</p:spTree></p:cSld>\
         <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
    );

    entries.push((
        "[Content_Types].xml".to_string(),
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
             <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
             <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
             <Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>\
             <Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/>\
             <Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>\
             <Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>\
             {ct_overrides}</Types>"
        ),
    ));
    entries.push((
        "_rels/.rels".to_string(),
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"ppt/presentation.xml\"/>\
         </Relationships>"
            .to_string(),
    ));
    entries.push((
        "ppt/presentation.xml".to_string(),
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <p:presentation xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
             xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
             xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
             <p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>\
             <p:sldIdLst>{sld_ids}</p:sldIdLst>\
             <p:sldSz cx=\"{PPTX_W}\" cy=\"{PPTX_H}\"/>\
             <p:notesSz cx=\"{PPTX_H}\" cy=\"{PPTX_W}\"/></p:presentation>"
        ),
    ));
    entries.push((
        "ppt/_rels/presentation.xml.rels".to_string(),
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
             {pres_rels}</Relationships>"
        ),
    ));
    entries.push(("ppt/slideMasters/slideMaster1.xml".to_string(), master));
    entries.push((
        "ppt/slideMasters/_rels/slideMaster1.xml.rels".to_string(),
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme1.xml\"/>\
         </Relationships>"
            .to_string(),
    ));
    entries.push(("ppt/slideLayouts/slideLayout1.xml".to_string(), layout));
    entries.push((
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels".to_string(),
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/>\
         </Relationships>"
            .to_string(),
    ));
    entries.push(("ppt/theme/theme1.xml".to_string(), PPTX_THEME.to_string()));
    Ok(entries)
}

// ---------- Tauri 命令 ----------

fn run_export(
    path: &str,
    spec_json: &str,
    overwrite: Option<bool>,
    exts: &[&str],
    builder: fn(&Value) -> Result<Vec<(String, String)>, String>,
    workspace_path: Option<&str>,
) -> Result<ExportOutcome, String> {
    let target = check_path(path, exts, overwrite.unwrap_or(false), workspace_path)?;
    let spec = parse_spec(spec_json)?;
    let entries = builder(&spec)?;
    let size = write_zip(&target, entries)?;
    Ok(ExportOutcome {
        path: target.to_string_lossy().into_owned(),
        size,
    })
}

#[derive(serde::Serialize, Debug)]
pub(crate) struct ExportOutcome {
    pub(crate) path: String,
    pub(crate) size: u64,
}

#[tauri::command]
pub(crate) async fn export_docx(
    path: String,
    spec_json: String,
    overwrite: Option<bool>,
    workspace_path: Option<String>,
) -> Result<ExportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_export(&path, &spec_json, overwrite, &["docx"], build_docx, workspace_path.as_deref())
    })
    .await
    .map_err(|e| format!("export_docx 任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn export_xlsx(
    path: String,
    spec_json: String,
    overwrite: Option<bool>,
    workspace_path: Option<String>,
) -> Result<ExportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_export(&path, &spec_json, overwrite, &["xlsx"], build_xlsx, workspace_path.as_deref())
    })
    .await
    .map_err(|e| format!("export_xlsx 任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn export_pptx(
    path: String,
    spec_json: String,
    overwrite: Option<bool>,
    workspace_path: Option<String>,
) -> Result<ExportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_export(&path, &spec_json, overwrite, &["pptx"], build_pptx, workspace_path.as_deref())
    })
    .await
    .map_err(|e| format!("export_pptx 任务失败: {e}"))?
}

/// 把纯文本/Markdown 正文直接落盘为 .md 文件（不走 OOXML 渲染，保留原文）。
/// 复用 check_path 的围栏：绝对路径、No-Go Zones、项目工作区边界、扩展名、覆盖开关、自动建目录。
#[tauri::command]
pub(crate) async fn write_text_file(
    path: String,
    content: String,
    overwrite: Option<bool>,
    workspace_path: Option<String>,
) -> Result<ExportOutcome, String> {
    let overwrite = overwrite.unwrap_or(false);
    let p = check_path(&path, &["md", "markdown"], overwrite, workspace_path.as_deref())?;
    std::fs::write(&p, content.as_bytes()).map_err(|e| format!("写入文件失败: {e}"))?;
    let size = std::fs::metadata(&p)
        .map_err(|e| format!("读取文件元数据失败: {e}"))?
        .len();
    Ok(ExportOutcome {
        path: p.to_string_lossy().to_string(),
        size,
    })
}

/// 校验产物路径在本机是否真实存在（供前端打开/下载前检查，杜绝虚拟路径静默失败）。
#[tauri::command]
pub(crate) fn path_exists(path: String) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    let p = std::path::Path::new(trimmed);
    p.is_absolute() && p.is_file()
}

/// 默认产物目录：模型未指定输出路径时的落盘位置。
/// Windows 优先 OneDrive 重定向的 Documents，其次 USERPROFILE\Documents；
/// 其他平台取 ~/Documents；都拿不到时退回当前目录。
#[tauri::command]
pub(crate) fn default_artifact_dir() -> String {
    if cfg!(windows) {
        if let Ok(up) = std::env::var("USERPROFILE") {
            let candidates = [
                format!("{up}\\OneDrive\\Documents"),
                format!("{up}\\Documents"),
            ];
            for candidate in &candidates {
                if std::path::Path::new(candidate).is_dir() {
                    return candidate.clone();
                }
            }
            return candidates[1].clone();
        }
    } else if let Ok(home) = std::env::var("HOME") {
        return format!("{home}/Documents");
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// ---------- 单元测试（生成真实文件并校验 zip/XML 结构） ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn read_entry(path: &Path, name: &str) -> String {
        let f = std::fs::File::open(path).unwrap();
        let mut z = zip::ZipArchive::new(f).unwrap();
        let mut s = String::new();
        use std::io::Read;
        z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
        s
    }

    fn assert_well_formed_xml(path: &Path) {
        let f = std::fs::File::open(path).unwrap();
        let mut z = zip::ZipArchive::new(f).unwrap();
        use std::io::Read;
        for i in 0..z.len() {
            let mut file = z.by_index(i).unwrap();
            let mut s = String::new();
            file.read_to_string(&mut s).unwrap();
            let mut reader = quick_xml::Reader::from_str(&s);
            reader.config_mut().trim_text(true);
            let mut buf = Vec::new();
            loop {
                match reader.read_event_into(&mut buf) {
                    Ok(quick_xml::events::Event::Eof) => break,
                    Ok(_) => buf.clear(),
                    Err(e) => panic!("{} 中 {} XML 解析失败: {e}", path.display(), file.name()),
                }
            }
        }
    }

    #[test]
    fn docx_generates_valid_package() {
        let dir = std::env::temp_dir().join("omni-office-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.docx");
        let spec = r#"{"title":"季度报告","children":[
            {"type":"h2","text":"一、概览"},
            {"type":"p","text":"这是 **加粗** 混排段落。"},
            {"type":"bullet","text":"要点甲"},
            {"type":"number","text":"步骤一"},
            {"type":"table","rows":[["名称","数值"],["甲",1]],"header":true},
            {"type":"pagebreak"}
        ]}"#;
        let outcome = run_export(path.to_str().unwrap(), spec, Some(true), &["docx"], build_docx, None).unwrap();
        assert!(outcome.size > 500);
        assert!(read_entry(&path, "word/document.xml").contains("季度报告"));
        assert_well_formed_xml(&path);
    }

    #[test]
    fn xlsx_generates_valid_package() {
        let dir = std::env::temp_dir().join("omni-office-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.xlsx");
        let spec = r#"{"sheets":[{"name":"销售","rows":[
            ["月份","销售额",{"text":"备注","style":"header"}],
            ["1月",1200],
            ["2月",1500],
            ["合计",{"formula":"SUM(B2:B3)"}]
        ]}]}"#;
        let outcome = run_export(path.to_str().unwrap(), spec, Some(true), &["xlsx"], build_xlsx, None).unwrap();
        assert!(outcome.size > 500);
        let sheet = read_entry(&path, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("inlineStr"));
        assert!(sheet.contains("<f>SUM(B2:B3)</f>"));
        assert_well_formed_xml(&path);
    }

    #[test]
    fn pptx_generates_valid_package() {
        let dir = std::env::temp_dir().join("omni-office-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.pptx");
        let spec = r#"{"slides":[
            {"title":"开场","bullets":["第一点","第二点"]},
            {"title":"收尾","bullets":["总结"]}
        ]}"#;
        let outcome = run_export(path.to_str().unwrap(), spec, Some(true), &["pptx"], build_pptx, None).unwrap();
        assert!(outcome.size > 1500);
        assert!(read_entry(&path, "ppt/presentation.xml").contains("sldIdLst"));
        assert!(read_entry(&path, "ppt/slides/slide1.xml").contains("开场"));
        assert_well_formed_xml(&path);
    }

    #[test]
    fn refuses_existing_file_without_overwrite() {
        let dir = std::env::temp_dir().join("omni-office-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("exists.docx");
        std::fs::write(&path, b"x").unwrap();
        let err = run_export(
            path.to_str().unwrap(),
            r#"{"children":[{"type":"p","text":"a"}]}"#,
            None,
            &["docx"],
            build_docx,
            None,
        )
        .unwrap_err();
        assert!(err.contains("已存在"));
    }

    #[test]
    fn refuses_no_go_zone_write() {
        // 系统/密钥目录应被兜底拒绝（不依赖前端拦截）。
        let no_go = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
        let path = format!("{no_go}\\System32\\omni-evil.docx");
        let err = run_export(
            &path,
            r#"{"children":[{"type":"p","text":"a"}]}"#,
            Some(true),
            &["docx"],
            build_docx,
            None,
        )
        .unwrap_err();
        assert!(err.contains("禁止写入"), "实际报错：{err}");
    }

    #[test]
    fn refuses_out_of_workspace_write() {
        // 项目会话下，越界绝对路径应被兜底拒绝。
        let dir = std::env::temp_dir().join("omni-office-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("outside.docx");
        let err = run_export(
            path.to_str().unwrap(),
            r#"{"children":[{"type":"p","text":"a"}]}"#,
            Some(true),
            &["docx"],
            build_docx,
            Some("D:/nonexistent-workspace-root"),
        )
        .unwrap_err();
        assert!(err.contains("项目工作区内"), "实际报错：{err}");
    }

    #[test]
    fn allows_within_workspace_write() {
        // 工作区内的绝对路径应放行。
        let ws = std::env::temp_dir().join("omni-ws-test");
        std::fs::create_dir_all(&ws).unwrap();
        let path = ws.join("inside.docx");
        let outcome = run_export(
            path.to_str().unwrap(),
            r#"{"children":[{"type":"p","text":"a"}]}"#,
            Some(true),
            &["docx"],
            build_docx,
            ws.to_str(),
        )
        .unwrap();
        assert!(outcome.size > 0);
    }

    // ---------- write_text_file（/export_md 落盘）围栏 ----------

    #[test]
    fn write_text_file_allows_md_and_markdown_ext() {
        // write_text_file 复用 check_path：.md / .markdown 应通过扩展名校验。
        let ws = std::env::temp_dir().join("omni-ws-test");
        std::fs::create_dir_all(&ws).unwrap();
        let ok_md = check_path(ws.join("a.md").to_str().unwrap(), &["md", "markdown"], true, ws.to_str());
        assert!(ok_md.is_ok(), "预期 .md 通过：{:?}", ok_md.err());
        let ok_markdown = check_path(ws.join("b.markdown").to_str().unwrap(), &["md", "markdown"], true, ws.to_str());
        assert!(ok_markdown.is_ok(), "预期 .markdown 通过：{:?}", ok_markdown.err());
    }

    #[test]
    fn write_text_file_rejects_non_md_ext() {
        let ws = std::env::temp_dir().join("omni-ws-test");
        std::fs::create_dir_all(&ws).unwrap();
        let err = check_path(ws.join("c.txt").to_str().unwrap(), &["md", "markdown"], true, ws.to_str()).unwrap_err();
        assert!(err.contains("扩展名"), "实际报错：{err}");
    }

    #[test]
    fn write_text_file_refuses_existing_without_overwrite() {
        let ws = std::env::temp_dir().join("omni-ws-test");
        std::fs::create_dir_all(&ws).unwrap();
        let path = ws.join("dup.md");
        std::fs::write(&path, b"old").unwrap();
        let err = check_path(path.to_str().unwrap(), &["md", "markdown"], false, ws.to_str()).unwrap_err();
        assert!(err.contains("已存在"), "实际报错：{err}");
        // overwrite=true 应放行
        assert!(check_path(path.to_str().unwrap(), &["md", "markdown"], true, ws.to_str()).is_ok());
    }

    #[test]
    fn write_text_file_refuses_no_go_zone() {
        let no_go = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
        let path = format!("{no_go}\\System32\\omni-evil.md");
        let err = check_path(&path, &["md", "markdown"], true, None).unwrap_err();
        assert!(err.contains("禁止写入"), "实际报错：{err}");
    }
}
