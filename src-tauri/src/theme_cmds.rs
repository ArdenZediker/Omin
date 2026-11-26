use font_kit::source::SystemSource;

#[tauri::command]
pub(crate) fn list_system_fonts() -> Vec<String> {
    let mut families = SystemSource::new().all_families().unwrap_or_default();
    families.retain(|family| !family.trim().is_empty());
    families.sort_by_key(|family| family.to_lowercase());
    families.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    families
}
