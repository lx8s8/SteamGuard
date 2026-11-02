//! Plaintext backup adapters, based on Aegis vault.md and 2FAS BackupContent.
use super::{decode_base32, json_string, Json, Token};
use std::collections::BTreeMap;

fn number(value: &Json, key: &str, default: u64) -> Result<u64, String> {
    match value.get(key) {
        None | Some(Json::Null) => Ok(default),
        Some(n) => n.as_u64().ok_or_else(|| "备份中的 OTP 数字参数无效".into()),
    }
}
fn convert(name: String, issuer: String, kind: String, info: &Json) -> Result<Token, String> {
    let kind = kind.to_lowercase();
    if !["totp", "hotp", "steam"].contains(&kind.as_str()) {
        return Err("备份包含暂不支持的 OTP 类型，请改用标准 OTP 二维码或链接导出".into());
    }
    let secret =
        zeroize::Zeroizing::new(json_string(info, &["secret"]).ok_or("备份中的令牌缺少密钥")?);
    let digits = u32::try_from(number(info, "digits", if kind == "steam" { 5 } else { 6 })?)
        .map_err(|_| "备份中的 OTP 位数无效")?;
    let period = number(info, "period", 30)?;
    let counter = number(info, "counter", 0)?;
    let mut token = Token::new(
        if name.is_empty() {
            "Authenticator".into()
        } else {
            name
        },
        kind,
        decode_base32(&secret)?,
    );
    token.issuer = issuer;
    token.digits = digits;
    token.period = period;
    token.counter = counter;
    token.algorithm = json_string(info, &["algo", "algorithm"])
        .unwrap_or("SHA1".into())
        .replace('-', "")
        .to_uppercase();
    if let Err(error) = token.validate() {
        token.erase();
        return Err(error);
    }
    Ok(token)
}
pub fn detect(value: &Json) -> Option<Result<Vec<Token>, String>> {
    if value.get("db").is_some() && value.get("version").is_some() {
        Some(aegis(value))
    } else if value.get("services").is_some() || value.get("servicesEncrypted").is_some() {
        Some(twofas(value))
    } else {
        None
    }
}
fn aegis(value: &Json) -> Result<Vec<Token>, String> {
    if value["version"].as_u64() != Some(1) {
        return Err("不支持的 Aegis 备份版本".into());
    }
    let db = value
        .get("db")
        .filter(|v| v.is_object())
        .ok_or("这是加密的 Aegis 备份，请先在 Aegis 导出未加密 JSON 文件")?;
    if !(1..=3).contains(&number(db, "version", 1)?) {
        return Err("不支持的 Aegis 内容版本".into());
    }
    let entries = db
        .get("entries")
        .and_then(Json::as_array)
        .ok_or("Aegis 备份缺少 entries")?;
    let groups = db
        .get("groups")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|g| {
            Some((
                g.get("uuid")?.as_str()?.to_owned(),
                g.get("name")?.as_str()?.to_owned(),
            ))
        })
        .collect::<BTreeMap<_, _>>();
    // This app has one group per token. Preserve the first group from multi-group exports.
    collect(entries, |entry| {
        let info = entry.get("info").ok_or("Aegis 令牌缺少 info")?;
        let mut token = convert(
            json_string(entry, &["name"]).unwrap_or_default(),
            json_string(entry, &["issuer"]).unwrap_or_default(),
            json_string(entry, &["type"]).ok_or("Aegis 令牌缺少类型")?,
            info,
        )?;
        token.group = entry
            .get("groups")
            .and_then(Json::as_array)
            .and_then(|ids| {
                ids.iter()
                    .find_map(|id| id.as_str().and_then(|id| groups.get(id)).cloned())
            })
            .or_else(|| json_string(entry, &["group"]));
        Ok(token)
    })
}
fn twofas(value: &Json) -> Result<Vec<Token>, String> {
    if value
        .get("servicesEncrypted")
        .and_then(Json::as_str)
        .is_some_and(|s| !s.is_empty())
        || value
            .get("reference")
            .and_then(Json::as_str)
            .is_some_and(|s| !s.is_empty())
    {
        return Err("这是加密的 2FAS 备份，请先在 2FAS 导出未加密文件".into());
    }
    if !(1..=4).contains(&number(value, "schemaVersion", 1)?) {
        return Err("不支持的 2FAS 备份版本".into());
    }
    let entries = value
        .get("services")
        .and_then(Json::as_array)
        .ok_or("2FAS 备份缺少 services")?;
    let groups = value
        .get("groups")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|g| {
            Some((
                g.get("id")?.as_str()?.to_owned(),
                g.get("name")?.as_str()?.to_owned(),
            ))
        })
        .collect::<BTreeMap<_, _>>();
    collect(entries, |entry| {
        let otp = entry
            .get("otp")
            .filter(|v| v.is_object())
            .ok_or("2FAS 令牌缺少 otp 参数")?;
        let mut info = otp.clone();
        info["secret"] = entry.get("secret").cloned().ok_or("2FAS 令牌缺少密钥")?;
        let mut token = convert(
            json_string(otp, &["account", "label"])
                .or_else(|| json_string(entry, &["name"]))
                .unwrap_or_default(),
            json_string(otp, &["issuer"])
                .or_else(|| json_string(entry, &["name"]))
                .unwrap_or_default(),
            json_string(otp, &["tokenType"]).unwrap_or("totp".into()),
            &info,
        )?;
        token.group = entry
            .get("groupId")
            .and_then(Json::as_str)
            .and_then(|id| groups.get(id))
            .cloned();
        Ok(token)
    })
}
fn collect(
    entries: &[Json],
    parse: impl Fn(&Json) -> Result<Token, String>,
) -> Result<Vec<Token>, String> {
    if entries.is_empty() || entries.len() > 1000 {
        return Err("备份为空或超过 1000 个令牌限制".into());
    }
    let mut tokens = Vec::new();
    for entry in entries {
        match parse(entry).and_then(|mut token| {
            if let Err(error) = token.validate() {
                token.erase();
                return Err(error);
            }
            Ok(token)
        }) {
            Ok(token) => tokens.push(token),
            Err(error) => {
                tokens.iter_mut().for_each(Token::erase);
                return Err(error);
            }
        }
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aegis_plain_preserves_parameters_and_first_group_without_importing_icons_or_notes() {
        let value = serde_json::json!({"version":1,"header":{},"db":{"version":3,"groups":[{"uuid":"a","name":"Work"},{"uuid":"b","name":"Personal"}],"entries":[{
            "type":"hotp","name":"Synthetic","issuer":"Example","groups":["a","b"],"icon":"ignored", "note":"ignored",
            "info":{"secret":"GEZDGNBVGY3TQOJQ","algo":"SHA256","digits":8,"counter":72}
        }]}});
        let tokens = detect(&value).unwrap().unwrap();
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].algorithm, "SHA256");
        assert_eq!(tokens[0].counter, 72);
        assert_eq!(tokens[0].digits, 8);
        assert_eq!(tokens[0].group.as_deref(), Some("Work"));
        assert!(tokens[0].steam_data.is_none());
    }
    #[test]
    fn twofas_plain_preserves_account_period_and_group() {
        let value = serde_json::json!({"schemaVersion":4,"groups":[{"id":"a","name":"Personal"}],"services":[{
            "name":"Example","secret":"GEZDGNBVGY3TQOJQ","groupId":"a",
            "otp":{"account":"synthetic@example.test","issuer":"Example","tokenType":"TOTP","digits":8,"period":60,"algorithm":"SHA512"}
        }]});
        let tokens = detect(&value).unwrap().unwrap();
        assert_eq!(tokens[0].name, "synthetic@example.test");
        assert_eq!(tokens[0].period, 60);
        assert_eq!(tokens[0].algorithm, "SHA512");
        assert_eq!(tokens[0].group.as_deref(), Some("Personal"));
    }
    #[test]
    fn encrypted_and_unsupported_foreign_records_are_not_silently_skipped() {
        for value in [
            serde_json::json!({"version":1,"db":"ciphertext"}),
            serde_json::json!({"services":[],"servicesEncrypted":"ciphertext"}),
        ] {
            assert!(detect(&value).unwrap().err().unwrap().contains("加密"));
        }
        let value = serde_json::json!({"version":1,"db":{"version":3,"entries":[
            {"type":"totp","name":"Valid","info":{"secret":"GEZDGNBVGY3TQOJQ"}},
            {"type":"yandex","name":"Unsupported","info":{"secret":"GEZDGNBVGY3TQOJQ"}}
        ]}});
        assert!(detect(&value).unwrap().is_err());
        let value = serde_json::json!({"schemaVersion":4,"services":[{"name":"Invalid","secret":"GEZDGNBVGY3TQOJQ","otp":{"digits":4294967302u64}}]});
        assert!(detect(&value).unwrap().is_err());
    }
}
