use crate::{models::Token, AppState};
use serde::Serialize;
use tauri::State;
#[derive(Serialize)]
pub struct Export {
    pages: Vec<String>,
}
#[tauri::command]
pub fn token_export_qr_batch(s: State<AppState>, ids: Vec<String>) -> Result<Export, String> {
    if ids.is_empty()
        || ids.len() > 1000
        || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
    {
        return Err("请选择有效的令牌".into());
    }
    let mut v = s.vault()?;
    let d = v.ensure()?;
    let mut tokens: Vec<Token> = ids
        .iter()
        .map(|id| {
            d.tokens
                .iter()
                .find(|t| &t.id == id)
                .cloned()
                .ok_or_else(|| "令牌不存在".to_string())
        })
        .collect::<Result<_, _>>()?;
    let result = crate::import::qr::export_batch(&tokens).map(|pages| Export { pages });
    tokens.iter_mut().for_each(Token::erase);
    v.touch();
    result
}
