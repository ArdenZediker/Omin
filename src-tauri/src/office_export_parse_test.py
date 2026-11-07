"""Read retained C8 fixtures with independent OOXML consumers; never write files.

Usage: python office_export_parse_test.py <OFFICE_DELIVERY_OUTPUT directory>
Requires python-docx, openpyxl, python-pptx. Missing libraries are a failure,
not a substitute XML-only pass. Uses actual exports from the ignored Rust test.
"""
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


def verify(output: Path) -> None:
    from docx import Document
    from openpyxl import load_workbook
    from pptx import Presentation

    for extension in ("docx", "xlsx", "pptx"):
        path = output / f"sample.{extension}"
        with zipfile.ZipFile(path) as package:
            assert package.testzip() is None, f"ZIP CRC failure: {path}"
            for name in package.namelist():
                if name.endswith((".xml", ".rels")):
                    ET.fromstring(package.read(name))

    document = Document(output / "sample.docx")
    paragraphs = [paragraph.text for paragraph in document.paragraphs]
    assert "交付 & 验证" in paragraphs
    assert "中文 重点 <原文> 😀" in paragraphs
    assert any(run.bold and run.text == "重点" for paragraph in document.paragraphs for run in paragraph.runs)
    assert len(document.tables) == 1
    assert [[cell.text for cell in row.cells] for row in document.tables[0].rows] == [["名称", "数值"], ["样本", "42"]]

    workbook = load_workbook(output / "sample.xlsx", data_only=False)
    try:
        assert workbook.sheetnames == ["销售汇总与交付校验记录", "说明"]
        sheet = workbook.worksheets[0]
        assert sheet["B2"].value == 12 and sheet["B3"].value == 30
        assert sheet["C2"].value is True and sheet["C3"].value is False
        assert sheet["B4"].value == "=SUM(B2:B3)"
        assert sheet["B4"].data_type == "f"
        assert sheet["C4"].value == "完成" and sheet["C4"].has_style
        assert workbook.calculation.fullCalcOnLoad is True
        assert workbook.worksheets[1]["A1"].value == "保留 <原文> & 中文 😀"
    finally:
        workbook.close()

    presentation = Presentation(output / "sample.pptx")
    assert len(presentation.slides) == 2
    assert presentation.slide_width == 12192000 and presentation.slide_height == 6858000
    slides = [[shape.text for shape in slide.shapes if shape.has_text_frame] for slide in presentation.slides]
    assert slides == [["交付 & 验证", "第一项 <原文>\n中文 😀"], ["结论", "完成"]]
    print("PASS: independent DOCX/XLSX/PPTX readers, ZIP CRC, XML, text, tables, boolean cells, formulas and slides")
    print("Formula recalculation and native Office rendering require separate application validation.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python office_export_parse_test.py <OFFICE_DELIVERY_OUTPUT directory>")
    verify(Path(sys.argv[1]).resolve(strict=True))
