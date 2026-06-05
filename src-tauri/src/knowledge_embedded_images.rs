use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::{DynamicImage, ImageBuffer, ImageFormat, Luma, Rgb, Rgba};
use lopdf::{Dictionary as LoDictionary, Document as LoDocument, Object as LoObject, ObjectId, Stream as LoStream};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Cursor, Read};
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedImageAssetCandidate {
    pub source_name: String,
    pub mime_type: Option<String>,
    pub file_extension: Option<String>,
    pub bytes: Vec<u8>,
    pub page_index: Option<i64>,
    pub asset_index: i64,
    pub anchor_text: Option<String>,
    pub ocr_text: Option<String>,
    pub caption_text: Option<String>,
    pub thumbnail_data_url: Option<String>,
}

#[derive(Debug, Clone)]
struct DocxImageOccurrence {
    target: String,
    anchor_text: Option<String>,
}

pub fn extract_docx_embedded_images(bytes: &[u8]) -> Result<Vec<EmbeddedImageAssetCandidate>, String> {
    let cursor = Cursor::new(bytes.to_vec());
    let mut archive = ZipArchive::new(cursor).map_err(|err| err.to_string())?;
    let relationships = read_docx_relationships(&mut archive);
    let occurrences = read_docx_image_occurrences(&mut archive, &relationships);
    let media_entries = read_docx_media_entries(&mut archive)?;
    let mut assets = Vec::new();
    let mut used_targets = HashSet::new();

    for occurrence in occurrences {
        let Some((source_name, image_bytes)) = media_entries.get(&occurrence.target) else {
            continue;
        };
        let extension = extension_from_name(source_name);
        assets.push(EmbeddedImageAssetCandidate {
            source_name: source_name.clone(),
            mime_type: mime_type_from_extension(extension.as_deref()),
            file_extension: extension,
            bytes: image_bytes.clone(),
            page_index: None,
            asset_index: assets.len() as i64,
            anchor_text: occurrence.anchor_text,
            ocr_text: None,
            caption_text: None,
            thumbnail_data_url: build_thumbnail_data_url(image_bytes),
        });
        used_targets.insert(occurrence.target);
    }

    for (path, (source_name, image_bytes)) in media_entries {
        if used_targets.contains(&path) {
            continue;
        }
        let extension = extension_from_name(&source_name);
        assets.push(EmbeddedImageAssetCandidate {
            source_name,
            mime_type: mime_type_from_extension(extension.as_deref()),
            file_extension: extension,
            bytes: image_bytes.clone(),
            page_index: None,
            asset_index: assets.len() as i64,
            anchor_text: None,
            ocr_text: None,
            caption_text: None,
            thumbnail_data_url: build_thumbnail_data_url(&image_bytes),
        });
    }

    Ok(assets)
}

pub fn extract_pdf_embedded_images(bytes: &[u8]) -> Result<Vec<EmbeddedImageAssetCandidate>, String> {
    let document = LoDocument::load_mem(bytes).map_err(|err| err.to_string())?;
    let mut assets = Vec::new();
    let mut seen_object_ids = HashSet::new();

    for (page_index, (_, page_id)) in document.get_pages().into_iter().enumerate() {
        let Some(resources) = load_pdf_page_resources(&document, page_id) else {
            continue;
        };
        let Some(xobjects) = load_pdf_xobject_dictionary(&document, resources) else {
            continue;
        };

        for (name, object) in xobjects {
            let Some(object_id) = object.as_reference().ok() else {
                continue;
            };
            if !seen_object_ids.insert(object_id) {
                continue;
            }
            let Some((mime_type, file_extension, image_bytes)) =
                extract_pdf_image_bytes(&document, object_id)
            else {
                continue;
            };
            let source_name = format!("page-{}-{}.{}", page_index + 1, String::from_utf8_lossy(name), file_extension);
            assets.push(EmbeddedImageAssetCandidate {
                source_name,
                mime_type: Some(mime_type),
                file_extension: Some(file_extension),
                bytes: image_bytes.clone(),
                page_index: Some(page_index as i64),
                asset_index: assets.len() as i64,
                anchor_text: None,
                ocr_text: None,
                caption_text: None,
                thumbnail_data_url: build_thumbnail_data_url(&image_bytes),
            });
        }
    }

    Ok(assets)
}

pub fn build_thumbnail_data_url(bytes: &[u8]) -> Option<String> {
    let image = image::load_from_memory(bytes).ok()?;
    let thumbnail = image.thumbnail(240, 240);
    let mut encoded = Vec::new();
    thumbnail
        .write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(encoded)
    ))
}

fn read_docx_relationships(archive: &mut ZipArchive<Cursor<Vec<u8>>>) -> HashMap<String, String> {
    let Ok(mut file) = archive.by_name("word/_rels/document.xml.rels") else {
        return HashMap::new();
    };
    let mut xml = String::new();
    if file.read_to_string(&mut xml).is_err() {
        return HashMap::new();
    }

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut relationships = HashMap::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) => {
                if local_xml_name(event.name().as_ref()) != b"Relationship" {
                    buffer.clear();
                    continue;
                }

                let mut relationship_id = None;
                let mut target = None;
                for attribute in event.attributes().flatten() {
                    match local_xml_name(attribute.key.as_ref()) {
                        b"Id" => {
                            relationship_id = Some(
                                String::from_utf8_lossy(attribute.value.as_ref()).to_string(),
                            );
                        }
                        b"Target" => {
                            target = Some(
                                normalize_docx_target(
                                    &String::from_utf8_lossy(attribute.value.as_ref()),
                                ),
                            );
                        }
                        _ => {}
                    }
                }

                if let (Some(relationship_id), Some(target)) = (relationship_id, target) {
                    relationships.insert(relationship_id, target);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buffer.clear();
    }

    relationships
}

fn read_docx_image_occurrences(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    relationships: &HashMap<String, String>,
) -> Vec<DocxImageOccurrence> {
    let Ok(mut file) = archive.by_name("word/document.xml") else {
        return Vec::new();
    };
    let mut xml = String::new();
    if file.read_to_string(&mut xml).is_err() {
        return Vec::new();
    }

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut occurrences = Vec::new();
    let mut current_paragraph = String::new();
    let mut last_paragraph = None::<String>;
    let mut inside_text = false;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => match local_xml_name(event.name().as_ref()) {
                b"p" => current_paragraph.clear(),
                b"t" => inside_text = true,
                b"blip" | b"imagedata" => {
                    if let Some(target) = resolve_docx_image_target(&event, relationships) {
                        occurrences.push(DocxImageOccurrence {
                            target,
                            anchor_text: select_docx_anchor_text(&current_paragraph, last_paragraph.as_deref()),
                        });
                    }
                }
                _ => {}
            },
            Ok(Event::Empty(event)) => {
                if matches!(local_xml_name(event.name().as_ref()), b"blip" | b"imagedata") {
                    if let Some(target) = resolve_docx_image_target(&event, relationships) {
                        occurrences.push(DocxImageOccurrence {
                            target,
                            anchor_text: select_docx_anchor_text(&current_paragraph, last_paragraph.as_deref()),
                        });
                    }
                }
            }
            Ok(Event::Text(event)) => {
                if inside_text {
                    current_paragraph.push_str(&String::from_utf8_lossy(event.as_ref()));
                }
            }
            Ok(Event::CData(event)) => {
                if inside_text {
                    current_paragraph.push_str(&String::from_utf8_lossy(event.as_ref()));
                }
            }
            Ok(Event::End(event)) => match local_xml_name(event.name().as_ref()) {
                b"t" => inside_text = false,
                b"p" => {
                    if let Some(text) = normalize_anchor_text(&current_paragraph) {
                        last_paragraph = Some(text);
                    }
                    current_paragraph.clear();
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buffer.clear();
    }

    occurrences
}

fn read_docx_media_entries(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
) -> Result<BTreeMap<String, (String, Vec<u8>)>, String> {
    let mut media_entries = BTreeMap::new();

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|err| err.to_string())?;
        let entry_path = file.name().replace('\\', "/");
        if !entry_path.starts_with("word/media/") {
            continue;
        }

        let source_name = entry_path
            .rsplit('/')
            .next()
            .unwrap_or("embedded-image")
            .to_string();
        if !is_supported_image_name(&source_name) {
            continue;
        }

        let mut image_bytes = Vec::new();
        file.read_to_end(&mut image_bytes)
            .map_err(|err| err.to_string())?;
        media_entries.insert(entry_path, (source_name, image_bytes));
    }

    Ok(media_entries)
}

fn resolve_docx_image_target(
    event: &BytesStart<'_>,
    relationships: &HashMap<String, String>,
) -> Option<String> {
    let relationship_id = event
        .attributes()
        .flatten()
        .find_map(|attribute| match local_xml_name(attribute.key.as_ref()) {
            b"embed" | b"id" => Some(String::from_utf8_lossy(attribute.value.as_ref()).to_string()),
            _ => None,
        })?;
    relationships.get(&relationship_id).cloned()
}

fn select_docx_anchor_text(current_paragraph: &str, last_paragraph: Option<&str>) -> Option<String> {
    normalize_anchor_text(current_paragraph).or_else(|| last_paragraph.map(str::to_string))
}

fn normalize_anchor_text(value: &str) -> Option<String> {
    let normalized = value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.trim().is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_docx_target(value: &str) -> String {
    let trimmed = value.trim().replace('\\', "/");
    if trimmed.starts_with("word/") {
        trimmed
    } else if trimmed.starts_with('/') {
        trimmed.trim_start_matches('/').to_string()
    } else {
        format!("word/{trimmed}")
    }
}

fn local_xml_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn is_supported_image_name(value: &str) -> bool {
    matches!(
        extension_from_name(value).as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp")
    )
}

fn extension_from_name(value: &str) -> Option<String> {
    value
        .rsplit('.')
        .next()
        .map(|part| part.trim().to_lowercase())
        .filter(|part| !part.is_empty() && part != value)
}

fn mime_type_from_extension(extension: Option<&str>) -> Option<String> {
    match extension? {
        "png" => Some("image/png".to_string()),
        "jpg" | "jpeg" => Some("image/jpeg".to_string()),
        "gif" => Some("image/gif".to_string()),
        "webp" => Some("image/webp".to_string()),
        "bmp" => Some("image/bmp".to_string()),
        _ => None,
    }
}

fn load_pdf_page_resources<'a>(document: &'a LoDocument, page_id: ObjectId) -> Option<&'a LoDictionary> {
    let page = document.get_object(page_id).ok()?;
    let page_dict = page.as_dict().ok()?;
    let resources = page_dict.get(b"Resources").ok()?;
    resolve_pdf_dictionary(document, resources)
}

fn load_pdf_xobject_dictionary<'a>(
    document: &'a LoDocument,
    resources: &'a LoDictionary,
) -> Option<&'a LoDictionary> {
    let xobject = resources.get(b"XObject").ok()?;
    resolve_pdf_dictionary(document, xobject)
}

fn resolve_pdf_dictionary<'a>(document: &'a LoDocument, object: &'a LoObject) -> Option<&'a LoDictionary> {
    match object {
        LoObject::Dictionary(dictionary) => Some(dictionary),
        LoObject::Reference(object_id) => document.get_object(*object_id).ok()?.as_dict().ok(),
        _ => None,
    }
}

fn extract_pdf_image_bytes(
    document: &LoDocument,
    object_id: ObjectId,
) -> Option<(String, String, Vec<u8>)> {
    let object = document.get_object(object_id).ok()?;
    let stream = object.as_stream().ok()?;
    if !is_pdf_image_stream(stream) {
        return None;
    }

    let filters = pdf_stream_filters(stream);
    if filters.iter().any(|filter| filter == "DCTDecode") {
        return Some((
            "image/jpeg".to_string(),
            "jpg".to_string(),
            stream.content.clone(),
        ));
    }
    if filters.iter().any(|filter| filter == "JPXDecode") {
        return Some((
            "image/jp2".to_string(),
            "jp2".to_string(),
            stream.content.clone(),
        ));
    }

    let raw = stream.decompressed_content().ok()?;
    let width = stream.dict.get(b"Width").ok()?.as_i64().ok()? as u32;
    let height = stream.dict.get(b"Height").ok()?.as_i64().ok()? as u32;
    let bits_per_component = stream
        .dict
        .get(b"BitsPerComponent")
        .ok()
        .and_then(|value| value.as_i64().ok())
        .unwrap_or(8);
    if bits_per_component != 8 {
        return None;
    }

    let color_space = pdf_color_space_name(stream.dict.get(b"ColorSpace").ok());
    let image = match color_space.as_deref() {
        Some("DeviceGray") => {
            let buffer = ImageBuffer::<Luma<u8>, Vec<u8>>::from_vec(width, height, raw)?;
            DynamicImage::ImageLuma8(buffer)
        }
        Some("DeviceRGB") | None => {
            let buffer = ImageBuffer::<Rgb<u8>, Vec<u8>>::from_vec(width, height, raw)?;
            DynamicImage::ImageRgb8(buffer)
        }
        Some("DeviceRGBA") => {
            let buffer = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_vec(width, height, raw)?;
            DynamicImage::ImageRgba8(buffer)
        }
        _ => return None,
    };

    let mut encoded = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
        .ok()?;
    Some((
        "image/png".to_string(),
        "png".to_string(),
        encoded,
    ))
}

fn is_pdf_image_stream(stream: &LoStream) -> bool {
    matches!(
        stream
            .dict
            .get(b"Subtype")
            .ok()
            .and_then(pdf_name_from_object)
            .as_deref(),
        Some("Image")
    )
}

fn pdf_stream_filters(stream: &LoStream) -> Vec<String> {
    match stream.dict.get(b"Filter").ok() {
        Some(LoObject::Name(name)) => vec![String::from_utf8_lossy(name).to_string()],
        Some(LoObject::Array(items)) => items
            .iter()
            .filter_map(pdf_name_from_object)
            .collect(),
        _ => Vec::new(),
    }
}

fn pdf_color_space_name(object: Option<&LoObject>) -> Option<String> {
    match object? {
        LoObject::Name(name) => Some(String::from_utf8_lossy(name).to_string()),
        LoObject::Array(items) => items.first().and_then(pdf_name_from_object),
        LoObject::Reference(_) => None,
        _ => None,
    }
}

fn pdf_name_from_object(object: &LoObject) -> Option<String> {
    match object {
        LoObject::Name(name) => Some(String::from_utf8_lossy(name).to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn build_docx_with_embedded_png() -> Vec<u8> {
        let cursor = Cursor::new(Vec::<u8>::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = SimpleFileOptions::default();

        writer.start_file("[Content_Types].xml", options).unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>"#,
            )
            .unwrap();

        writer.start_file("word/_rels/document.xml.rels", options).unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>"#,
            )
            .unwrap();

        writer.start_file("word/document.xml", options).unwrap();
        writer
            .write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>System diagram</w:t></w:r>
      <w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r>
    </w:p>
  </w:body>
</w:document>"#,
            )
            .unwrap();

        writer.start_file("word/media/image1.png", options).unwrap();
        writer
            .write_all(&[
                0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
                0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
                0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
                0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB1, 0x00, 0x00, 0x00,
                0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
            ])
            .unwrap();

        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn extract_docx_embedded_images_returns_media_entries() {
        let bytes = build_docx_with_embedded_png();

        let assets = extract_docx_embedded_images(&bytes).unwrap();

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].source_name, "image1.png");
        assert_eq!(assets[0].mime_type.as_deref(), Some("image/png"));
        assert_eq!(assets[0].anchor_text.as_deref(), Some("System diagram"));
    }

    #[test]
    fn extract_pdf_embedded_images_returns_empty_without_failure() {
        use lopdf::{dictionary, Document, Object, Stream};

        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let page_id = document.new_object_id();
        let contents_id = document.add_object(Stream::new(dictionary! {}, Vec::new()));

        document.objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => contents_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            }),
        );
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);

        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let assets = extract_pdf_embedded_images(&bytes).unwrap();
        assert!(assets.is_empty());
    }
}
