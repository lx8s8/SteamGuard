//! Compatibility import for WattToolkit 2.x exports, SDA maFiles and OTP URIs.
//! Account data never leaves the process and is never written to a diagnostic log.
use crate::models::Token;
use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::{engine::general_purpose::STANDARD, Engine};
use rmpv::Value as Mp;
use serde_json::Value as Json;
use sha1::Digest;
use std::io::Cursor;

mod encrypted;
mod foreign;
pub mod qr;

const MAX_IMPORT_BYTES: usize = 16 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;
// Original application format parameter, distributed in WattToolkit's public client SDK resource.
const WATT_AES_PARAMS: &[u8] = &[
    10, 0, 125, 133, 90, 31, 176, 112, 200, 42, 210, 219, 96, 162, 198, 186, 9, 85, 181, 66, 197,
    211, 111, 212, 118, 38, 184, 169, 62, 28, 25, 234, 192, 71, 96, 8, 241, 189, 197, 5, 85, 163,
    65, 121, 186, 83, 87, 107, 179, 135,
];

/// Import all records atomically; a malformed/locked record rejects the entire file.
pub fn parse_import(
    data: &[u8],
    password: Option<&str>,
    filename: &str,
) -> Result<Vec<Token>, String> {
    if data.is_empty() || data.len() > MAX_IMPORT_BYTES {
        return Err("导入文件为空或超过 16 MiB 限制".into());
    }
    let mut result = if let Ok(text) = std::str::from_utf8(data) {
        let text = text.trim_start_matches('\u{feff}').trim();
        let first = text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with('#'))
            .unwrap_or("");
        if first.starts_with("otpauth://") || first.starts_with("otpauth-migration://") {
            import_uris(text)
        } else if text.starts_with('{') || text.starts_with('[') {
            import_json(text, password, filename)
        } else if text.starts_with('<') {
            import_winauth_xml(text)
        } else {
            import_watt(data, password)
        }
    } else {
        import_watt(data, password)
    }?;
    if result.is_empty() || result.len() > MAX_RECORDS {
        result.iter_mut().for_each(Token::erase);
        return Err("文件中没有有效令牌，或令牌数量超过限制".into());
    }
    for token in &result {
        if let Err(error) = validate_token(token) {
            result.iter_mut().for_each(Token::erase);
            return Err(error);
        }
    }
    Ok(result)
}

fn validate_token(token: &Token) -> Result<(), String> {
    if token.secret.is_empty() || token.secret.len() > 4096 {
        return Err("令牌密钥为空或长度无效".into());
    }
    if token.period == 0 || token.period > 86400 || !(4..=10).contains(&token.digits) {
        return Err("令牌周期或位数无效".into());
    }
    if !matches!(token.algorithm.as_str(), "SHA1" | "SHA256" | "SHA512") {
        return Err("不支持的令牌哈希算法".into());
    }
    Ok(())
}

fn map_get<'a>(value: &'a Mp, key: &str) -> Option<&'a Mp> {
    value
        .as_map()?
        .iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .map(|(_, v)| v)
}

fn field_str(value: &Mp, key: &str) -> Option<String> {
    map_get(value, key)?.as_str().map(str::to_owned)
}

fn field_u64(value: &Mp, key: &str) -> Option<u64> {
    map_get(value, key)?.as_u64()
}

fn mp_bytes(value: &Mp) -> Option<Vec<u8>> {
    match value {
        Mp::Binary(v) => Some(v.clone()),
        Mp::Array(v) => v
            .iter()
            .map(|n| n.as_u64().and_then(|n| u8::try_from(n).ok()))
            .collect(),
        _ => None,
    }
}

fn decode_mp(data: &[u8], depth: usize) -> Result<Mp, String> {
    if depth > 4 || data.len() > MAX_IMPORT_BYTES {
        return Err("导出文件嵌套或解压大小超过限制".into());
    }
    let mut cursor = Cursor::new(data);
    let value = rmpv::decode::read_value_with_max_depth(&mut cursor, 48)
        .map_err(|_| "无法读取 WattToolkit MessagePack 导出格式".to_string())?;
    if cursor.position() != data.len() as u64 {
        return Err("导出文件包含无效的尾部数据".into());
    }
    if let Mp::Ext(99, payload) = &value {
        let mut header = Cursor::new(payload.as_slice());
        let length = rmpv::decode::read_value(&mut header)
            .ok()
            .and_then(|v| v.as_u64())
            .filter(|v| *v <= MAX_IMPORT_BYTES as u64)
            .ok_or("LZ4 解压长度无效")? as usize;
        let decoded = lz4_flex::block::decompress(&payload[header.position() as usize..], length)
            .map_err(|_| "导出文件 LZ4 数据损坏")?;
        if decoded.len() != length {
            return Err("导出文件 LZ4 长度不匹配".into());
        }
        return decode_mp(&decoded, depth + 1);
    }
    if let Mp::Array(values) = &value {
        if let Some(Mp::Ext(98, sizes)) = values.first() {
            let mut lengths = Cursor::new(sizes.as_slice());
            let mut decoded = Vec::new();
            for part in values.iter().skip(1) {
                let length = rmpv::decode::read_value(&mut lengths)
                    .ok()
                    .and_then(|v| v.as_u64())
                    .filter(|n| *n <= MAX_IMPORT_BYTES as u64)
                    .ok_or("LZ4 分段长度无效")? as usize;
                if decoded
                    .len()
                    .checked_add(length)
                    .filter(|n| *n <= MAX_IMPORT_BYTES)
                    .is_none()
                {
                    return Err("导出文件解压后超过 16 MiB 限制".into());
                }
                let compressed = part.as_slice().ok_or("LZ4 分段无效")?;
                let chunk = lz4_flex::block::decompress(compressed, length)
                    .map_err(|_| "导出文件 LZ4 数据损坏")?;
                if chunk.len() != length {
                    return Err("导出文件 LZ4 长度不匹配".into());
                }
                decoded.extend(chunk);
            }
            if lengths.position() != sizes.len() as u64 {
                return Err("LZ4 分段数量不匹配".into());
            }
            return decode_mp(&decoded, depth + 1);
        }
    }
    Ok(value)
}

fn u32_le(data: &[u8]) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        data.get(..4).ok_or("加密数据头不完整")?.try_into().unwrap(),
    ))
}

fn decrypt_cbc(data: &[u8], key: &[u8], iv: &[u8]) -> Result<Vec<u8>, String> {
    let result = match key.len() {
        16 => cbc::Decryptor::<aes::Aes128>::new_from_slices(key, iv)
            .map_err(|_| ())
            .and_then(|d| d.decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| ())),
        24 => cbc::Decryptor::<aes::Aes192>::new_from_slices(key, iv)
            .map_err(|_| ())
            .and_then(|d| d.decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| ())),
        32 => cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv)
            .map_err(|_| ())
            .and_then(|d| d.decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| ())),
        _ => Err(()),
    };
    result.map_err(|_| "导出文件解密失败：密码错误、数据损坏或不兼容的加密密钥".into())
}

fn decrypt_watt(data: &[u8], password: Option<&str>) -> Result<Vec<u8>, String> {
    let mode = u32_le(data)?;
    if matches!(mode, 2 | 4) {
        return Err(
            "此文件绑定了原电脑的本地加密。请在原 WattToolkit 中关闭「本机加密」后重新导出".into(),
        );
    }
    if !matches!(mode, 1 | 3) {
        return Err("不支持的 WattToolkit 加密模式".into());
    }
    let mut payload = data[4..].to_vec();
    if mode == 3 {
        let password = password
            .filter(|p| !p.trim().is_empty())
            .ok_or("此导出需要二级密码，请输入导出密码")?;
        if u32_le(&payload)? != 0 {
            return Err("不支持的二级密码加密版本".into());
        }
        // AESUtils.GetParameters: SHA1(password) || CRC32(password), IV = MD5(password).
        let mut key = sha1::Sha1::digest(password.as_bytes()).to_vec();
        key.extend(crc32fast::hash(password.as_bytes()).to_be_bytes());
        let iv = md5::Md5::digest(password.as_bytes());
        payload = decrypt_cbc(&payload[4..], &key, &iv)?;
    }
    if u32_le(&payload)? != 0 {
        return Err("不支持的 WattToolkit 内置加密密钥版本".into());
    }
    let key: Vec<u8> = WATT_AES_PARAMS[18..].iter().rev().copied().collect();
    decrypt_cbc(&payload[4..], &key, &WATT_AES_PARAMS[2..18])
}

fn import_watt(data: &[u8], password: Option<&str>) -> Result<Vec<Token>, String> {
    let value = decode_mp(data, 0)?;
    let rows = value.as_array().ok_or("WattToolkit 导出内容不是令牌列表")?;
    if rows.len() > MAX_RECORDS {
        return Err("令牌数量超过限制".into());
    }
    rows.iter()
        .map(|row| {
            if map_get(row, "IsNotLocal").and_then(Mp::as_bool) == Some(false) {
                return Err("此文件绑定原电脑，请关闭原软件的本机加密后重新导出".into());
            }
            let name_data = map_get(row, "Name")
                .and_then(mp_bytes)
                .ok_or("导出记录缺少名称")?;
            let name = String::from_utf8(decrypt_watt(&name_data, password)?)
                .map_err(|_| "令牌名称不是有效 UTF-8")?;
            let token_data = map_get(row, "Value")
                .and_then(mp_bytes)
                .ok_or("导出记录缺少令牌数据")?;
            let token_value = decode_mp(&decrypt_watt(&token_data, password)?, 0)?;
            let union = token_value
                .as_array()
                .filter(|v| v.len() == 2)
                .ok_or("令牌类型数据无效")?;
            let platform = union[0].as_u64().ok_or("令牌平台无效")?;
            let fields = &union[1];
            let kind = match platform {
                1 => "steam",
                13 => "hotp",
                11 => "battlenet",
                5 | 12 | 14 => "totp",
                _ => return Err("导出包含暂不支持的令牌平台".into()),
            };
            let secret = map_get(fields, "SecretKey")
                .and_then(mp_bytes)
                .ok_or("令牌密钥缺失")?;
            let mut token = Token::new(name, kind.into(), secret);
            token.issuer = field_str(fields, "Issuer").unwrap_or_else(|| {
                if kind == "steam" {
                    "Steam".into()
                } else {
                    String::new()
                }
            });
            token.digits =
                field_u64(fields, "CodeDigits").unwrap_or(if kind == "steam" { 5 } else { 6 })
                    as u32;
            token.period = field_u64(fields, "Period").unwrap_or(30);
            token.counter = field_u64(fields, "Counter").unwrap_or(0);
            token.algorithm = match field_u64(fields, "HMACType").unwrap_or(0) {
                0 => "SHA1",
                1 => "SHA256",
                2 => "SHA512",
                _ => return Err("未知的令牌哈希算法".into()),
            }
            .into();
            token.device_id = field_str(fields, "DeviceId");
            if let Some(text) = field_str(fields, "SteamData") {
                let steam: Json =
                    serde_json::from_str(&text).map_err(|_| "Steam 令牌附加数据损坏")?;
                apply_steam_data(&mut token, &steam);
                token.steam_data = Some(steam);
            }
            if kind == "battlenet" {
                if let Some(serial) = field_str(fields, "Serial") {
                    token.steam_data = Some(serde_json::json!({"serial": serial}));
                }
            }
            Ok(token)
        })
        .collect()
}

fn mp_map(fields: Vec<(&str, Mp)>) -> Mp {
    Mp::Map(fields.into_iter().map(|(k, v)| (Mp::from(k), v)).collect())
}

fn encode_mp(value: &Mp) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    rmpv::encode::write_value(&mut bytes, value).map_err(|_| "无法编码令牌导出文件")?;
    Ok(bytes)
}

fn encrypt_watt(data: &[u8], password: Option<&str>) -> Result<Vec<u8>, String> {
    let key: Vec<u8> = WATT_AES_PARAMS[18..].iter().rev().copied().collect();
    let ciphertext = cbc::Encryptor::<aes::Aes256>::new_from_slices(&key, &WATT_AES_PARAMS[2..18])
        .map_err(|_| "内置加密参数无效")?
        .encrypt_padded_vec_mut::<Pkcs7>(data);
    let mut payload = 0u32.to_le_bytes().to_vec();
    payload.extend(ciphertext);
    let mode = if let Some(password) = password.filter(|p| !p.trim().is_empty()) {
        let mut key = sha1::Sha1::digest(password.as_bytes()).to_vec();
        key.extend(crc32fast::hash(password.as_bytes()).to_be_bytes());
        let iv = md5::Md5::digest(password.as_bytes());
        let ciphertext = cbc::Encryptor::<aes::Aes192>::new_from_slices(&key, &iv)
            .map_err(|_| "导出密码派生失败")?
            .encrypt_padded_vec_mut::<Pkcs7>(&payload);
        payload = 0u32.to_le_bytes().to_vec();
        payload.extend(ciphertext);
        3u32
    } else {
        1u32
    };
    let mut result = mode.to_le_bytes().to_vec();
    result.extend(payload);
    Ok(result)
}

/// Write the original WattToolkit 2.x MessagePack + LZ4 .mpo format.
/// This legacy compatibility format is distinct from the authenticated vault format.
pub fn export_mpo(tokens: &[Token], password: Option<&str>) -> Result<Vec<u8>, String> {
    if tokens.is_empty() || tokens.len() > MAX_RECORDS {
        return Err("没有可导出的令牌或数量超过限制".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间无效")?
        .as_secs();
    let timestamp = Mp::Array(vec![
        Mp::Ext(-1, (now as u32).to_be_bytes().to_vec()),
        Mp::from(0),
    ]);
    let mut rows = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        validate_token(token)?;
        let platform = match token.kind.as_str() {
            "steam" => 1,
            "hotp" => 13,
            "battlenet" => 11,
            "totp" => 14,
            _ => return Err("无法导出未知的令牌类型".into()),
        };
        let algorithm = match token.algorithm.as_str() {
            "SHA1" => 0,
            "SHA256" => 1,
            "SHA512" => 2,
            _ => return Err("无法导出未知哈希算法".into()),
        };
        let mut fields = vec![
            ("Issuer", Mp::from(token.issuer.clone())),
            ("ServerTimeDiff", Mp::from(0)),
            ("LastServerTime", Mp::from(0)),
            ("SecretKey", Mp::Binary(token.secret.clone())),
            ("CodeDigits", Mp::from(token.digits)),
            ("HMACType", Mp::from(algorithm)),
            ("Period", Mp::from(token.period)),
        ];
        if token.kind == "hotp" {
            fields.push(("Counter", Mp::from(token.counter)));
        }
        if token.kind == "steam" {
            let mut steam = token
                .steam_data
                .clone()
                .filter(Json::is_object)
                .unwrap_or_else(|| serde_json::json!({}));
            steam["shared_secret"] = Json::String(STANDARD.encode(&token.secret));
            if let Some(v) = &token.steam_id {
                steam["steamid"] = Json::String(v.clone());
            }
            if let Some(v) = &token.account_name {
                steam["account_name"] = Json::String(v.clone());
            }
            if let Some(v) = &token.identity_secret {
                steam["identity_secret"] = Json::String(v.clone());
            }
            let serial = json_string(&steam, &["serial_number"]).unwrap_or_default();
            fields.push(("Serial", Mp::from(serial)));
            fields.push((
                "DeviceId",
                token.device_id.clone().map(Mp::from).unwrap_or(Mp::Nil),
            ));
            fields.push(("SteamData", Mp::from(steam.to_string())));
            fields.push(("SessionData", Mp::Nil));
        }
        if token.kind == "battlenet" {
            let serial = token
                .steam_data
                .as_ref()
                .and_then(|j| json_string(j, &["serial", "Serial"]));
            fields.push(("Serial", serial.map(Mp::from).unwrap_or(Mp::Nil)));
        }
        let value = encode_mp(&Mp::Array(vec![Mp::from(platform), mp_map(fields)]))?;
        let row = mp_map(vec![
            ("Index", Mp::from(index as u64 + 1)),
            (
                "Name",
                Mp::Binary(encrypt_watt(token.name.as_bytes(), None)?),
            ),
            ("Value", Mp::Binary(encrypt_watt(&value, password)?)),
            ("IsNotLocal", Mp::from(true)),
            (
                "IsNeedSecondaryPassword",
                Mp::from(password.is_some_and(|p| !p.trim().is_empty())),
            ),
            ("Created", timestamp.clone()),
            ("LastUpdate", timestamp.clone()),
        ]);
        rows.push(row);
    }
    let raw = encode_mp(&Mp::Array(rows))?;
    if raw.len() > MAX_IMPORT_BYTES {
        return Err("导出数据超过 16 MiB 限制".into());
    }
    let lengths = encode_mp(&Mp::from(raw.len() as u64))?;
    encode_mp(&Mp::Array(vec![
        Mp::Ext(98, lengths),
        Mp::Binary(lz4_flex::block::compress(&raw)),
    ]))
}

fn decode_hex(text: &str) -> Result<Vec<u8>, String> {
    let text: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return Err("WinAuth 密钥十六进制无效".into());
    }
    text.as_bytes()
        .chunks(2)
        .map(|c| {
            let hi = (c[0] as char)
                .to_digit(16)
                .ok_or("WinAuth 密钥十六进制无效")?;
            let lo = (c[1] as char)
                .to_digit(16)
                .ok_or("WinAuth 密钥十六进制无效")?;
            Ok((hi * 16 + lo) as u8)
        })
        .collect()
}

fn import_winauth_xml(text: &str) -> Result<Vec<Token>, String> {
    let document =
        roxmltree::Document::parse(text).map_err(|_| "WinAuth XML 格式错误（不允许 DTD）")?;
    if document.descendants().filter(|n| n.is_element()).any(|n| {
        n.attribute("encrypted")
            .is_some_and(|v| !v.is_empty() && v != "false")
    }) {
        return Err(
            "暂不支持加密的 WinAuth XML，请先在 WinAuth 中导出未加密 XML 或 otpauth 文本".into(),
        );
    }
    let rows: Vec<_> = document
        .descendants()
        .filter(|n| {
            n.is_element()
                && n.tag_name()
                    .name()
                    .eq_ignore_ascii_case("WinAuthAuthenticator")
        })
        .collect();
    if rows.is_empty() {
        return Err("XML 中没有 WinAuthAuthenticator 记录".into());
    }
    let mut result = Vec::new();
    for row in rows {
        let value_node = row
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name() == "authenticator");
        let auth_type = row
            .attribute("type")
            .or_else(|| value_node.and_then(|n| n.attribute("type")))
            .ok_or("WinAuth 记录缺少类型")?;
        let kind = if auth_type.ends_with("SteamAuthenticator") {
            "steam"
        } else if auth_type.ends_with("HOTPAuthenticator") {
            "hotp"
        } else if auth_type.ends_with("BattleNetAuthenticator") {
            "battlenet"
        } else if [
            "GoogleAuthenticator",
            "MicrosoftAuthenticator",
            "TOTPAuthenticator",
        ]
        .iter()
        .any(|suffix| auth_type.ends_with(suffix))
        {
            "totp"
        } else {
            return Err("WinAuth 记录包含不支持的验证器类型".into());
        };
        let find_text = |tag| {
            row.descendants()
                .find(|n| n.is_element() && n.tag_name().name() == tag)
                .and_then(|n| n.text())
        };
        let name = find_text("name").unwrap_or("Authenticator");
        let secret_data = find_text("secretdata").ok_or("WinAuth 记录缺少 secretdata")?;
        let parts: Vec<&str> = secret_data.split('|').collect();
        let options: Vec<&str> = parts[0].split('\t').collect();
        let mut token = Token::new(name.into(), kind.into(), decode_hex(options[0])?);
        token.digits = options
            .get(1)
            .filter(|v| !v.is_empty())
            .map(|v| v.parse())
            .transpose()
            .map_err(|_| "WinAuth 位数无效")?
            .unwrap_or(if kind == "steam" {
                5
            } else if kind == "battlenet" {
                8
            } else {
                6
            });
        token.algorithm = options.get(2).unwrap_or(&"SHA1").to_uppercase();
        token.period = options
            .get(3)
            .filter(|v| !v.is_empty())
            .map(|v| v.parse())
            .transpose()
            .map_err(|_| "WinAuth 周期无效")?
            .unwrap_or(30);
        if kind == "hotp" {
            token.counter = parts
                .get(1)
                .map(|v| v.parse())
                .transpose()
                .map_err(|_| "WinAuth HOTP 计数无效")?
                .unwrap_or(0);
        }
        let hex_text = |index: usize| -> Result<Option<String>, String> {
            parts
                .get(index)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    String::from_utf8(decode_hex(s)?)
                        .map_err(|_| "WinAuth 附加数据不是 UTF-8".into())
                })
                .transpose()
        };
        if kind == "steam" {
            token.issuer = "Steam".into();
            token.device_id = hex_text(2)?;
            if let Some(text) = hex_text(3)? {
                let steam = if text.starts_with('{') {
                    serde_json::from_str(&text).map_err(|_| "WinAuth Steam JSON 无效")?
                } else {
                    serde_json::json!({"revocation_code": text})
                };
                apply_steam_data(&mut token, &steam);
                token.steam_data = Some(steam);
            }
        } else if kind == "battlenet" {
            token.issuer = "Battle.net".into();
            token.steam_data = Some(serde_json::json!({"serial": hex_text(1)?}));
        }
        result.push(token);
    }
    Ok(result)
}

fn json_string(v: &Json, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| v.get(*key))
        .and_then(|v| match v {
            Json::String(s) if !s.is_empty() => Some(s.clone()),
            Json::Number(n) => Some(n.to_string()),
            _ => None,
        })
}

fn apply_steam_data(token: &mut Token, steam: &Json) {
    token.steam_id = json_string(steam, &["steamid", "steam_id", "steamId"])
        .filter(|id| crate::models::known_steam_id(Some(id)).is_some())
        .or_else(|| {
            steam
                .get("Session")
                .and_then(|session| json_string(session, &["SteamID", "SteamId", "steamid"]))
        })
        .filter(|id| crate::models::known_steam_id(Some(id)).is_some());
    token.account_name = json_string(steam, &["account_name", "accountName"]);
    token.identity_secret = json_string(steam, &["identity_secret", "identitySecret"]);
    token.device_id = json_string(steam, &["device_id", "deviceId"]).or(token.device_id.take());
}

fn import_json(text: &str, password: Option<&str>, filename: &str) -> Result<Vec<Token>, String> {
    let source =
        encrypted::SecretJson(serde_json::from_str(text).map_err(|_| "JSON 文件格式错误")?);
    let value = &source.0;
    if let Some(result) = encrypted::detect(value, password) {
        let decoded = result?;
        return foreign::detect(&decoded.0).ok_or("不支持的加密备份类型")?;
    }
    if let Some(result) = foreign::detect(value) {
        return result;
    }
    let values = if let Some(array) = value.as_array() {
        array.as_slice()
    } else if let Some(array) = value.get("tokens").and_then(Json::as_array) {
        array.as_slice()
    } else {
        std::slice::from_ref(value)
    };
    let mut tokens = vec![];
    for value in values {
        let parsed = (|| {
            if let Some(uri) = value
                .get("uri")
                .and_then(Json::as_str)
                .filter(|s| s.starts_with("otpauth://"))
            {
                return import_uri(uri);
            }
            if let Some(secret) = json_string(value, &["shared_secret", "sharedSecret"]) {
                let secret = zeroize::Zeroizing::new(secret);
                let name = json_string(value, &["account_name", "accountName", "name"])
                    .unwrap_or_else(|| {
                        filename
                            .rsplit('/')
                            .next()
                            .unwrap_or("Steam")
                            .trim_end_matches(".maFile")
                            .into()
                    });
                let secret = STANDARD
                    .decode(secret.trim())
                    .map_err(|_| "Steam shared_secret 不是有效 Base64")?;
                let mut token = Token::new(name, "steam".into(), secret);
                token.issuer = "Steam".into();
                token.digits = 5;
                apply_steam_data(&mut token, value);
                token.steam_data = Some(value.clone());
                return Ok(token);
            }
            let secret = zeroize::Zeroizing::new(
                json_string(value, &["secret", "secretKey"])
                    .ok_or("JSON 缺少 shared_secret、secret 或 otpauth uri")?,
            );
            let kind = json_string(value, &["kind", "type"])
                .unwrap_or("totp".into())
                .to_lowercase();
            if !matches!(kind.as_str(), "steam" | "totp" | "hotp" | "battlenet") {
                return Err("JSON 令牌类型无效".into());
            }
            let number = |field: &str, default| -> Result<u64, String> {
                value
                    .get(field)
                    .map(|v| v.as_u64().ok_or_else(|| "JSON 令牌数字参数无效".into()))
                    .transpose()
                    .map(|n| n.unwrap_or(default))
            };
            let digits = u32::try_from(number("digits", if kind == "steam" { 5 } else { 6 })?)
                .map_err(|_| "JSON 令牌位数无效")?;
            let period = number("period", 30)?;
            let counter = number("counter", 0)?;
            let mut token = Token::new(
                json_string(value, &["name", "label"]).unwrap_or("Authenticator".into()),
                kind,
                decode_base32(&secret)?,
            );
            token.issuer = json_string(value, &["issuer"]).unwrap_or_default();
            token.algorithm = json_string(value, &["algorithm"])
                .unwrap_or("SHA1".into())
                .to_uppercase();
            token.digits = digits;
            token.period = period;
            token.counter = counter;
            Ok::<Token, String>(token)
        })();
        match parsed {
            Ok(token) => tokens.push(token),
            Err(error) => {
                tokens.iter_mut().for_each(Token::erase);
                return Err(error);
            }
        }
    }
    Ok(tokens)
}

fn decode_base32(secret: &str) -> Result<Vec<u8>, String> {
    let normalized = zeroize::Zeroizing::new(
        secret
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '=' && *c != '-')
            .flat_map(char::to_uppercase)
            .collect::<String>(),
    );
    data_encoding::BASE32_NOPAD
        .decode(normalized.as_bytes())
        .map_err(|_| "令牌密钥不是有效 Base32".into())
}

fn import_uris(text: &str) -> Result<Vec<Token>, String> {
    let lines = zeroize::Zeroizing::new(
        text.lines()
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with('#'))
            .map(str::to_owned)
            .collect::<Vec<_>>(),
    );
    let mut collection = qr::collect_text(&lines)?;
    if !collection.progress.complete {
        return Err(format!(
            "Google 导出尚未收齐：已收到 {}/{} 张，还缺第 {} 张。请扫描完整批次后再导入",
            collection.progress.received,
            collection.progress.expected,
            collection
                .progress
                .missing
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    Ok(std::mem::take(&mut collection.tokens))
}

fn import_uri(text: &str) -> Result<Token, String> {
    let url = url::Url::parse(text).map_err(|_| "OTP URI 格式错误")?;
    if url.scheme() != "otpauth" || !matches!(url.host_str(), Some("totp" | "hotp")) {
        return Err("仅支持 otpauth://totp 和 otpauth://hotp".into());
    }
    let params: std::collections::HashMap<String, String> =
        url.query_pairs().into_owned().collect();
    let param = |key: &str| params.get(key).map(String::as_str);
    let raw_label = url.path().trim_start_matches('/');
    let label = percent_decode(raw_label)?;
    let issuer = param("issuer")
        .map(str::to_owned)
        .or_else(|| label.split_once(':').map(|(i, _)| i.into()))
        .unwrap_or_default();
    let name = label
        .split_once(':')
        .map(|(_, n)| n.trim().to_owned())
        .unwrap_or_else(|| label.clone());
    let steam = param("encoder") == Some("steam") || issuer.eq_ignore_ascii_case("steam");
    let kind = if steam {
        "steam"
    } else {
        url.host_str().unwrap()
    };
    let secret = decode_base32(param("secret").ok_or("OTP URI 缺少 secret")?)?;
    let mut token = Token::new(
        if name.is_empty() {
            "Authenticator".into()
        } else {
            name
        },
        kind.into(),
        secret,
    );
    token.issuer = issuer;
    token.algorithm = param("algorithm").unwrap_or("SHA1").to_uppercase();
    token.digits = param("digits")
        .map(str::parse)
        .transpose()
        .map_err(|_| "OTP 位数无效")?
        .unwrap_or(if steam { 5 } else { 6 });
    token.period = param("period")
        .map(str::parse)
        .transpose()
        .map_err(|_| "OTP 周期无效")?
        .unwrap_or(30);
    token.counter = param("counter")
        .map(str::parse)
        .transpose()
        .map_err(|_| "HOTP counter 无效")?
        .unwrap_or(0);
    if kind == "hotp" && param("counter").is_none() {
        return Err("HOTP URI 缺少 counter".into());
    }
    Ok(token)
}

fn percent_decode(text: &str) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut input = text.as_bytes().iter().copied();
    while let Some(c) = input.next() {
        if c == b'%' {
            let hi = input
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or("URI 转义无效")?;
            let lo = input
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or("URI 转义无效")?;
            bytes.push((hi * 16 + lo) as u8);
        } else {
            bytes.push(c);
        }
    }
    String::from_utf8(bytes).map_err(|_| "URI 标签不是有效 UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_text_files_keep_large_imports_and_leading_comments_compatible() {
        let mut text = String::from("# Synthetic URI backup\n\n");
        for index in 0..150 {
            text.push_str(&format!(
                "otpauth://totp/Example:{index}?secret=GEZDGNBVGY3TQOJQ\n"
            ));
        }
        let tokens = parse_import(text.as_bytes(), None, "otp.txt").unwrap();
        assert_eq!(tokens.len(), 150);
        assert_eq!(tokens[149].name, "149");
    }

    #[test]
    fn import_uri_preserves_parameters_and_decodes_label() {
        let tokens = parse_import(b"otpauth://totp/Example%3Atest%40example.com?secret=GEZDGNBVGY3TQOJQ&issuer=Example&algorithm=SHA256&digits=8&period=60", None, "otp.txt").unwrap();
        assert_eq!(tokens[0].name, "test@example.com");
        assert_eq!(tokens[0].algorithm, "SHA256");
        assert_eq!(tokens[0].period, 60);
        assert_eq!(tokens[0].digits, 8);
    }

    #[test]
    fn invalid_import_is_atomic() {
        assert!(parse_import(
            b"otpauth://totp/test?secret=GEZDGNBVGY3TQOJQ\notpauth://totp/bad?secret=***",
            None,
            "otp.txt"
        )
        .is_err());
        assert!(parse_import(
            b"otpauth://totp/test?secret=GEZDGNBVGY3TQOJQ&period=0",
            None,
            "otp.txt"
        )
        .is_err());
        assert!(parse_import(
            b"otpauth://hotp/test?secret=GEZDGNBVGY3TQOJQ",
            None,
            "otp.txt"
        )
        .is_err());
    }

    #[test]
    fn imports_mafile_steam_fields() {
        let tokens = parse_import(br#"{"shared_secret":"MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=","identity_secret":"dGVzdA==","steamid":"76561198000000000","device_id":"android:test","account_name":"fixture"}"#, None, "fixture.maFile").unwrap();
        assert_eq!(tokens[0].kind, "steam");
        assert_eq!(tokens[0].digits, 5);
        assert_eq!(tokens[0].identity_secret.as_deref(), Some("dGVzdA=="));
        assert_eq!(tokens[0].steam_id.as_deref(), Some("76561198000000000"));
    }

    #[test]
    fn rejects_machine_bound_exports() {
        assert!(decrypt_watt(&[2, 0, 0, 0, 0], None)
            .unwrap_err()
            .contains("原电脑"));
    }

    #[test]
    fn mpo_export_roundtrip_preserves_secret_and_steam_confirmation_data() {
        let steam = parse_import(br#"{"shared_secret":"MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=","identity_secret":"dGVzdA==","steamid":"76561198000000000","device_id":"android:test","account_name":"fixture","serial_number":"123","revocation_code":"R00000"}"#, None, "fixture.maFile").unwrap().remove(0);
        let hotp = parse_import(
            b"otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQ&counter=42&algorithm=SHA512&digits=8",
            None,
            "fixture.txt",
        )
        .unwrap()
        .remove(0);
        let originals = vec![steam, hotp];
        for password in [None, Some("fixture-password")] {
            let encoded = export_mpo(&originals, password).unwrap();
            let decoded = parse_import(&encoded, password, "fixture.mpo").unwrap();
            assert_eq!(decoded.len(), 2);
            assert_eq!(decoded[0].secret, originals[0].secret);
            assert_eq!(decoded[0].identity_secret, originals[0].identity_secret);
            assert_eq!(decoded[0].steam_id, originals[0].steam_id);
            assert_eq!(decoded[0].device_id, originals[0].device_id);
            assert_eq!(decoded[0].steam_data, originals[0].steam_data);
            assert_eq!(decoded[1].secret, originals[1].secret);
            assert_eq!(decoded[1].counter, 42);
            assert_eq!(decoded[1].algorithm, "SHA512");
            assert_eq!(decoded[1].digits, 8);
            if password.is_some() {
                assert!(parse_import(&encoded, None, "fixture.mpo").is_err());
                assert!(parse_import(&encoded, Some("wrong-password"), "fixture.mpo").is_err());
            }
        }
    }

    #[test]
    fn zero_steam_id_uses_nested_session_identity() {
        let tokens = parse_import(br#"{"shared_secret":"MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=","steamid":0,"Session":{"SteamID":"76561198000000001"}}"#, None, "fixture.maFile").unwrap();
        assert_eq!(tokens[0].steam_id.as_deref(), Some("76561198000000001"));
        let tokens = parse_import(
            br#"{"shared_secret":"MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=","steamid":"0"}"#,
            None,
            "fixture.maFile",
        )
        .unwrap();
        assert!(tokens[0].steam_id.is_none());
    }
    #[test]
    fn imports_plain_winauth_xml_and_rejects_encrypted() {
        let tokens = parse_import(br#"<WinAuth><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>Fixture</name><authenticatordata><secretdata>31323334353637383930</secretdata></authenticatordata></WinAuthAuthenticator></WinAuth>"#, None, "fixture.xml").unwrap();
        assert_eq!(tokens[0].name, "Fixture");
        assert_eq!(tokens[0].secret, b"1234567890");
        assert!(parse_import(
            br#"<WinAuth encrypted="y">ciphertext</WinAuth>"#,
            Some("password"),
            "fixture.xml"
        )
        .err()
        .unwrap()
        .contains("加密"));
    }

    #[test]
    #[ignore = "Set WATT_TEST_MPO to a private real .mpo export; no account data is logged"]
    fn real_mpo_private_import() {
        let path =
            std::env::var("WATT_TEST_MPO").expect("WATT_TEST_MPO must point to a private export");
        let data = std::fs::read(path).unwrap();
        let tokens = parse_import(
            &data,
            std::env::var("WATT_TEST_PASSWORD").ok().as_deref(),
            "private.mpo",
        )
        .unwrap();
        assert!(!tokens.is_empty());
        let legacy_zero = tokens
            .iter()
            .filter(|token| {
                token
                    .steam_data
                    .as_ref()
                    .is_some_and(|data| data.get("steamid").is_some_and(|v| v == "0" || v == 0))
            })
            .count();
        println!(
            "Private import metadata only: records={}, legacy_zero_id={}, known_id={}",
            tokens.len(),
            legacy_zero,
            tokens
                .iter()
                .filter(|token| crate::models::known_steam_id(token.steam_id.as_deref()).is_some())
                .count()
        );
        for token in tokens {
            assert!(!token.secret.is_empty());
            if token.kind == "steam" {
                if let Some(id) = &token.steam_id {
                    assert!(crate::models::known_steam_id(Some(id)).is_some());
                }
                assert!(token.identity_secret.is_some());
                assert!(token.device_id.is_some());
            }
        }
    }
}
