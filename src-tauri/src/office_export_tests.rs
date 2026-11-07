//! Delivery regression tests, scoped to office_export. No shared fixtures or user files.
use super::*;
use quick_xml::events::Event;
use std::collections::{BTreeMap, HashSet};
use std::io::Read;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("omni-office-delivery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }

    fn assert_no_staging_files(&self) {
        for entry in std::fs::read_dir(&self.0).unwrap() {
            assert!(!entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".omni-office-"));
        }
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const DOCX_SPEC: &str = r#"{"title":"交付 & 验证","children":[
    {"type":"h2","text":"范围"},{"type":"p","text":"中文 **重点** <原文> 😀"},
    {"type":"bullet","text":"第一项"},{"type":"number","text":"第一步"},
    {"type":"table","rows":[["名称","数值"],["样本",42]],"header":true},
    {"type":"pagebreak"},{"type":"p","text":"结束"}]}"#;
const XLSX_SPEC: &str = r#"{"sheets":[
    {"name":"销售汇总与交付校验记录","rows":[["名称","数值","状态"],["甲",12,true],
      ["乙",30,false],["合计",{"formula":"SUM(B2:B3)"},{"text":"完成","style":"header"}]]},
    {"name":"说明","rows":[["保留 <原文> & 中文 😀"]]}]}"#;
const PPTX_SPEC: &str = r#"{"slides":[
    {"title":"交付 & 验证","bullets":["第一项 <原文>","中文 😀"]},
    {"title":"结论","bullets":["完成"]}]}"#;

type Builder = fn(&Value) -> Result<Vec<(String, String)>, String>;

fn cases() -> [(&'static str, &'static str, Builder); 3] {
    [
        ("docx", DOCX_SPEC, build_docx),
        ("xlsx", XLSX_SPEC, build_xlsx),
        ("pptx", PPTX_SPEC, build_pptx),
    ]
}

fn export(
    path: &Path,
    spec: &str,
    ext: &str,
    builder: Builder,
    overwrite: Option<bool>,
) -> Result<ExportOutcome, String> {
    run_export(
        path.to_str().unwrap(),
        spec,
        overwrite,
        &[ext],
        builder,
        path.parent().unwrap().to_str(),
        SandboxMode::DangerFullAccess,
        false,
    )
}

// Parse actual XML events, attributes, entities and root nesting; not substring-only validation.
fn elements(xml: &str, tag: &str) -> Vec<BTreeMap<String, String>> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut result = Vec::new();
    let mut depth = 0;
    let mut roots = 0;
    loop {
        match reader.read_event().unwrap() {
            Event::Start(event) | Event::Empty(event) => {
                // Track nesting separately below with a second parser: both event kinds
                // intentionally share attribute decoding here.
                let attrs: BTreeMap<_, _> = event
                    .attributes()
                    .map(|attr| {
                        let attr = attr.unwrap();
                        (
                            String::from_utf8(attr.key.as_ref().to_vec()).unwrap(),
                            attr.decode_and_unescape_value(reader.decoder())
                                .unwrap()
                                .into_owned(),
                        )
                    })
                    .collect();
                if event.name().as_ref() == tag.as_bytes() {
                    result.push(attrs);
                }
            }
            Event::Text(text) => {
                text.unescape().unwrap();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let mut reader = quick_xml::Reader::from_str(xml);
    loop {
        match reader.read_event().unwrap() {
            Event::Start(_) => {
                if depth == 0 {
                    roots += 1;
                }
                depth += 1;
            }
            Event::Empty(_) => {
                if depth == 0 {
                    roots += 1;
                }
            }
            Event::End(_) => {
                assert!(depth > 0);
                depth -= 1;
            }
            Event::DocType(_) => panic!("generated packages must not use DTDs"),
            Event::Eof => break,
            _ => {}
        }
    }
    assert_eq!(depth, 0);
    assert_eq!(roots, 1);
    result
}

fn read_package(path: &Path) -> BTreeMap<String, String> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut parts = BTreeMap::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).unwrap();
        let mut xml = String::new();
        entry.read_to_string(&mut xml).unwrap(); // Fully reads each part, including CRC verification.
        assert!(valid_xml_text(&xml));
        elements(&xml, "");
        assert!(parts.insert(entry.name().to_string(), xml).is_none());
    }
    for part in elements(&parts["[Content_Types].xml"], "Override") {
        assert!(parts.contains_key(part["PartName"].trim_start_matches('/')));
    }
    for (name, xml) in parts.iter().filter(|(name, _)| name.ends_with(".rels")) {
        let base = if name == "_rels/.rels" {
            ""
        } else {
            name.split_once("_rels/").unwrap().0
        };
        let mut ids = HashSet::new();
        for rel in elements(xml, "Relationship") {
            assert!(
                ids.insert(rel["Id"].clone()),
                "duplicate relationship in {name}"
            );
            assert!(!rel.contains_key("TargetMode"));
            let mut segments: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
            for segment in rel["Target"].split('/') {
                match segment {
                    ".." => {
                        assert!(segments.pop().is_some());
                    }
                    "." | "" => {}
                    _ => segments.push(segment),
                }
            }
            assert!(
                parts.contains_key(&segments.join("/")),
                "missing relationship target: {name} {rel:?}"
            );
        }
    }
    parts
}

#[test]
fn all_formats_publish_parseable_packages_and_truthful_outcomes() {
    let dir = TestDir::new();
    for (ext, spec, builder) in cases() {
        let path = dir.0.join(format!("sample.{ext}"));
        let outcome = export(&path, spec, ext, builder, None).unwrap();
        assert_eq!(Path::new(&outcome.path), path);
        assert_eq!(outcome.size, std::fs::metadata(&path).unwrap().len());
        assert!(outcome.size > 0);
        assert!(outcome.diff.is_none());
        let parts = read_package(&path);
        match ext {
            "docx" => {
                assert_eq!(elements(&parts["word/document.xml"], "w:tbl").len(), 1);
                assert!(elements(&parts["word/document.xml"], "w:br")
                    .iter()
                    .any(|attrs| attrs.get("w:type").is_some_and(|v| v == "page")));
            }
            "xlsx" => {
                assert_eq!(elements(&parts["xl/workbook.xml"], "sheet").len(), 2);
                let cells = elements(&parts["xl/worksheets/sheet1.xml"], "c");
                for cell in ["C2", "C3"] {
                    assert_eq!(
                        cells.iter().find(|attrs| attrs["r"] == cell).unwrap()["t"],
                        "b"
                    );
                }
                assert_eq!(elements(&parts["xl/worksheets/sheet1.xml"], "f").len(), 1);
                assert_eq!(
                    elements(&parts["xl/workbook.xml"], "calcPr")[0]["fullCalcOnLoad"],
                    "1"
                );
            }
            "pptx" => {
                assert_eq!(elements(&parts["ppt/presentation.xml"], "p:sldId").len(), 2);
                assert_eq!(
                    elements(&parts["ppt/slides/slide1.xml"], "a:buChar").len(),
                    2
                );
            }
            _ => unreachable!(),
        }
        dir.assert_no_staging_files();
    }
}

#[test]
fn all_formats_refuse_implicit_overwrite_and_allow_explicit_replacement() {
    let dir = TestDir::new();
    for (ext, spec, builder) in cases() {
        let path = dir.0.join(format!("existing.{ext}"));
        std::fs::write(&path, b"original user file").unwrap();
        for overwrite in [None, Some(false)] {
            assert!(export(&path, spec, ext, builder, overwrite)
                .unwrap_err()
                .contains("已存在"));
            assert_eq!(std::fs::read(&path).unwrap(), b"original user file");
        }
        export(&path, spec, ext, builder, Some(true)).unwrap();
        read_package(&path);
        dir.assert_no_staging_files();
    }
}

#[test]
fn failed_write_never_publishes_partial_files_or_truncates_existing_files() {
    let dir = TestDir::new();
    for existing in [false, true] {
        let path = dir.0.join(format!("failure-{existing}.docx"));
        if existing {
            std::fs::write(&path, b"original").unwrap();
        }
        let error = write_office_atomically(&path, existing, |file| {
            file.write_all(b"partial zip").unwrap();
            if existing {
                assert_eq!(std::fs::read(&path).unwrap(), b"original");
            } else {
                assert!(!path.exists());
            }
            Err("injected disk write failure".to_string())
        })
        .unwrap_err();
        assert!(error.contains("injected"));
        if existing {
            assert_eq!(std::fs::read(&path).unwrap(), b"original");
        } else {
            assert!(!path.exists());
        }
        dir.assert_no_staging_files();
    }
}

#[test]
fn target_created_after_preflight_is_not_overwritten() {
    let dir = TestDir::new();
    let path = dir.0.join("race.docx");
    check_path(
        path.to_str().unwrap(),
        &["docx"],
        false,
        dir.0.to_str(),
        SandboxMode::DangerFullAccess,
        false,
    )
    .unwrap();
    let error = write_office_atomically(&path, false, |file| {
        file.write_all(b"staged content").unwrap();
        std::fs::write(&path, b"concurrent owner").unwrap();
        Ok(())
    })
    .unwrap_err();
    assert!(error.contains("已存在"));
    assert_eq!(std::fs::read(&path).unwrap(), b"concurrent owner");
    dir.assert_no_staging_files();
}

#[test]
fn two_concurrent_exports_have_exactly_one_winner() {
    let dir = TestDir::new();
    let path = dir.0.join("concurrent.docx");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = [b"first", b"other"]
        .into_iter()
        .map(|content| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                write_office_atomically(&path, false, |file| {
                    file.write_all(content).unwrap();
                    barrier.wait();
                    Ok(())
                })
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(results
        .iter()
        .filter_map(|result| result.as_ref().err())
        .all(|error| error.contains("已存在")));
    let bytes = std::fs::read(&path).unwrap();
    assert!(bytes == b"first" || bytes == b"other");
    dir.assert_no_staging_files();
}

#[test]
fn failed_publish_preserves_destination_directory_and_cleans_staging() {
    let dir = TestDir::new();
    let path = dir.0.join("directory.docx");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("owned.txt"), b"keep").unwrap();
    assert!(export(&path, DOCX_SPEC, "docx", build_docx, Some(true)).is_err());
    assert_eq!(std::fs::read(path.join("owned.txt")).unwrap(), b"keep");
    dir.assert_no_staging_files();
}

#[cfg(windows)]
#[test]
fn locked_destination_is_not_destroyed() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = TestDir::new();
    let path = dir.0.join("locked.docx");
    std::fs::write(&path, b"original").unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    assert!(export(&path, DOCX_SPEC, "docx", build_docx, Some(true)).is_err());
    drop(lock);
    assert_eq!(std::fs::read(&path).unwrap(), b"original");
    dir.assert_no_staging_files();
}

#[test]
fn invalid_spec_and_xml_characters_leave_existing_data_untouched() {
    let dir = TestDir::new();
    for (ext, spec, builder) in cases() {
        let path = dir.0.join(format!("invalid.{ext}"));
        std::fs::write(&path, b"original").unwrap();
        for invalid in [
            "not json".to_string(),
            "{}".to_string(),
            spec.replace("交付", "\\u0000交付"),
        ] {
            assert!(export(&path, &invalid, ext, builder, Some(true)).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), b"original");
        }
        dir.assert_no_staging_files();
    }
}

#[test]
fn workbook_names_accept_chinese_but_reject_duplicates_and_invalid_names() {
    assert!(build_xlsx(&serde_json::from_str(XLSX_SPEC).unwrap()).is_ok());
    for names in [
        vec!["Sales", "sales"],
        vec!["'bad"],
        vec!["bad'"],
        vec!["bad/name"],
    ] {
        let sheets: Vec<_> = names
            .iter()
            .map(|name| serde_json::json!({"name":name,"rows":[]}))
            .collect();
        assert!(build_xlsx(&serde_json::json!({"sheets":sheets})).is_err());
    }
}

/// Run only when coordinated by the integration owner. The env value must be an
/// existing directory within this checkout; output goes into a unique new child.
/// Then: python src/office_export_parse_test.py <printed-directory>
#[test]
#[ignore = "requires OMNI_OFFICE_TEST_OUTPUT; creates retained fixtures for independent Office readers"]
fn generate_office_delivery_fixtures() {
    let root =
        std::fs::canonicalize(std::env::var_os("OMNI_OFFICE_TEST_OUTPUT").expect(
            "set OMNI_OFFICE_TEST_OUTPUT to an existing output directory in this workspace",
        ))
        .unwrap();
    let workspace =
        std::fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()).unwrap();
    assert!(
        root.starts_with(&workspace),
        "fixture directory must stay in this workspace"
    );
    let output = root.join(format!("office-delivery-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&output).unwrap();
    for (ext, spec, builder) in cases() {
        let path = output.join(format!("sample.{ext}"));
        export(&path, spec, ext, builder, None).unwrap();
        read_package(&path);
    }
    println!("OFFICE_DELIVERY_OUTPUT={}", output.display());
}
