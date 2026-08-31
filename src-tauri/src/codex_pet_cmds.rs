
use crate::codex_pets;

#[tauri::command]
pub(crate) fn load_codex_pet_packages() -> Result<codex_pets::CodexPetPackageListPayload, String> {
    codex_pets::load_packages()
}

#[tauri::command]
pub(crate) fn import_codex_pet_package(
    input: codex_pets::ImportCodexPetPackageInput,
) -> Result<codex_pets::CodexPetPackageRecord, String> {
    codex_pets::import_package(input)
}

#[tauri::command]
pub(crate) fn load_workspace_pet_dir_command() -> Result<String, String> {
    codex_pets::load_workspace_pet_dir()
}
