//! Google Authenticator migration wire format, matched against Aegis' google_auth.proto.
//! Prost handles protobuf decoding; incomplete batches never become importable previews.
use super::{import_uri, validate_token};
use crate::models::Token;
use base64::{engine::general_purpose, Engine};
use prost::Message;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use zeroize::{Zeroize, Zeroizing};

pub const MAX_CODES: usize = 128;
const MAX_BYTES: usize = 1024 * 1024;
#[derive(Clone, PartialEq, Message)]
struct MigrationPayload {
    #[prost(message, repeated, tag = "1")]
    accounts: Vec<OtpParameters>,
    #[prost(int32, tag = "2")]
    version: i32,
    #[prost(int32, tag = "3")]
    batch_size: i32,
    #[prost(int32, tag = "4")]
    batch_index: i32,
    #[prost(int32, tag = "5")]
    batch_id: i32,
}
#[derive(Clone, PartialEq, Message)]
struct OtpParameters {
    #[prost(bytes = "vec", tag = "1")]
    secret: Vec<u8>,
    #[prost(string, tag = "2")]
    name: String,
    #[prost(string, tag = "3")]
    issuer: String,
    #[prost(int32, tag = "4")]
    algorithm: i32,
    #[prost(int32, tag = "5")]
    digits: i32,
    #[prost(int32, tag = "6")]
    kind: i32,
    #[prost(int64, tag = "7")]
    counter: i64,
}
impl Drop for OtpParameters {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub source: &'static str,
    pub received: usize,
    pub expected: usize,
    pub missing: Vec<usize>,
    pub duplicate_codes: usize,
    pub token_count: usize,
    pub complete: bool,
}
pub struct Collection {
    pub progress: Progress,
    pub tokens: Vec<Token>,
}
impl Drop for Collection {
    fn drop(&mut self) {
        self.tokens.iter_mut().for_each(Token::erase);
    }
}
fn decode(text: &str) -> Result<MigrationPayload, String> {
    let url = url::Url::parse(text).map_err(|_| "Google 迁移二维码格式无效")?;
    if url.scheme() != "otpauth-migration"
        || url.host_str() != Some("offline")
        || !matches!(url.path(), "" | "/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("不支持的 Google 迁移二维码地址".into());
    }
    let parameters = url
        .query_pairs()
        .filter(|(key, _)| key == "data")
        .collect::<Vec<_>>();
    if parameters.len() != 1 {
        return Err("Google 迁移二维码必须包含一个 data 参数".into());
    }
    let encoded = Zeroizing::new(parameters[0].1.replace(' ', "+"));
    let bytes = Zeroizing::new(
        [
            general_purpose::STANDARD,
            general_purpose::STANDARD_NO_PAD,
            general_purpose::URL_SAFE,
            general_purpose::URL_SAFE_NO_PAD,
        ]
        .iter()
        .find_map(|engine| engine.decode(encoded.as_bytes()).ok())
        .ok_or("Google 迁移 Base64 无效")?,
    );
    let payload =
        MigrationPayload::decode(bytes.as_slice()).map_err(|_| "Google 迁移数据损坏或被截断")?;
    // Current iOS exports use version 2 with the same fields and may omit batch_id.
    // Keep a finite compatibility boundary instead of silently accepting future formats.
    if !(0..=2).contains(&payload.version) {
        return Err(format!(
            "暂不支持 Google 迁移格式版本 {}，请更新应用",
            payload.version
        ));
    }
    let size = if payload.batch_size == 0 {
        1
    } else {
        payload.batch_size
    };
    if !(1..=MAX_CODES as i32).contains(&size)
        || payload.batch_index < 0
        || payload.batch_index >= size
    {
        return Err("Google 迁移二维码的批次数量或序号无效".into());
    }
    if payload.accounts.is_empty() || payload.accounts.len() > 1000 {
        return Err("Google 迁移二维码没有令牌或令牌过多".into());
    }
    Ok(payload)
}
fn token(account: &OtpParameters) -> Result<Token, String> {
    let kind = match account.kind {
        1 => "hotp",
        2 => "totp",
        _ => return Err("Google 迁移包含未知 OTP 类型".into()),
    };
    let counter = u64::try_from(account.counter).map_err(|_| "Google 迁移 HOTP 计数不能为负数")?;
    let mut token = Token::new(
        if account.name.trim().is_empty() {
            "Authenticator".into()
        } else {
            account.name.clone()
        },
        kind.into(),
        account.secret.clone(),
    );
    token.issuer = account.issuer.clone();
    token.algorithm = match account.algorithm {
        0 | 1 => "SHA1",
        2 => "SHA256",
        3 => "SHA512",
        _ => {
            token.erase();
            return Err("Google 迁移包含不支持的算法".into());
        }
    }
    .into();
    token.digits = match account.digits {
        0 | 1 => 6,
        2 => 8,
        _ => {
            token.erase();
            return Err("Google 迁移位数无效".into());
        }
    };
    token.counter = counter;
    if let Err(error) = validate_token(&token).and_then(|_| token.validate()) {
        token.erase();
        return Err(error);
    }
    Ok(token)
}
pub fn collect(payloads: &[String]) -> Result<Collection, String> {
    collect_with_limits(payloads, MAX_CODES, MAX_BYTES, 1000)
}
pub(super) fn collect_text(payloads: &[String]) -> Result<Collection, String> {
    collect_with_limits(
        payloads,
        super::MAX_RECORDS,
        super::MAX_IMPORT_BYTES,
        super::MAX_RECORDS,
    )
}
fn collect_with_limits(
    payloads: &[String],
    max_codes: usize,
    max_bytes: usize,
    max_tokens: usize,
) -> Result<Collection, String> {
    if payloads.is_empty()
        || payloads.len() > max_codes * 2
        || payloads.iter().map(String::len).sum::<usize>() > max_bytes
        || payloads.iter().any(|p| p.len() > 64 * 1024)
    {
        return Err("二维码内容为空或超过导入限制".into());
    }
    let mut collection = Collection {
        progress: Progress {
            source: "otp",
            received: 0,
            expected: 0,
            missing: vec![],
            duplicate_codes: 0,
            token_count: 0,
            complete: false,
        },
        tokens: vec![],
    };
    let mut batch = None;
    let mut pages: BTreeMap<i32, MigrationPayload> = BTreeMap::new();
    let mut regular = BTreeSet::new();
    for text in payloads {
        let text = text.trim();
        if text.starts_with("otpauth-migration://") {
            if !regular.is_empty() {
                return Err("请完成当前导入，再扫描另一种验证器二维码".into());
            }
            let payload = decode(text)?;
            let size = if payload.batch_size == 0 {
                1
            } else {
                payload.batch_size
            };
            let identity = (payload.batch_id, size, payload.version);
            if batch.is_some_and(|b| b != identity) {
                return Err("二维码来自不同的 Google 导出批次，请继续扫描同一次导出的二维码，或清空后重新开始".into());
            }
            batch = Some(identity);
            if let Some(existing) = pages.get(&payload.batch_index) {
                if existing != &payload {
                    return Err("同一批次序号出现不同内容，请清空后重新扫描完整批次".into());
                }
                collection.progress.duplicate_codes += 1;
            } else {
                pages.insert(payload.batch_index, payload);
            }
        } else if text.starts_with("otpauth://") {
            if batch.is_some() {
                return Err("请先收齐当前 Google 批次，再导入普通 OTP 二维码".into());
            }
            if regular.insert(Sha256::digest(text.as_bytes()).to_vec()) {
                let mut parsed = import_uri(text)?;
                if let Err(error) = validate_token(&parsed).and_then(|_| parsed.validate()) {
                    parsed.erase();
                    return Err(error);
                }
                collection.tokens.push(parsed);
            } else {
                collection.progress.duplicate_codes += 1;
            }
        } else {
            return Err("二维码不是支持的验证器格式，请使用 Google 导出码或 otpauth 设置码".into());
        }
    }
    if let Some((_, size, _)) = batch {
        collection.progress.source = "google";
        collection.progress.expected = size as usize;
        collection.progress.received = pages.len();
        collection.progress.missing = (0..size)
            .filter(|index| !pages.contains_key(index))
            .map(|i| i as usize + 1)
            .collect();
        for payload in pages.values() {
            for account in &payload.accounts {
                collection.tokens.push(token(account)?);
            }
        }
    } else {
        collection.progress.received = regular.len();
        collection.progress.expected = regular.len();
    }
    if collection.progress.received > max_codes || collection.tokens.len() > max_tokens {
        return Err("一次最多导入 128 张二维码和 1000 个令牌".into());
    }
    collection.progress.token_count = collection.tokens.len();
    collection.progress.complete = collection.progress.missing.is_empty();
    Ok(collection)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn uri(id: i32, size: i32, index: i32, label: &str) -> String {
        let payload = MigrationPayload {
            accounts: vec![OtpParameters {
                secret: b"12345678901234567890".to_vec(),
                name: label.into(),
                issuer: "Example".into(),
                algorithm: 3,
                digits: 2,
                kind: 1,
                counter: 42,
            }],
            version: 1,
            batch_size: size,
            batch_index: index,
            batch_id: id,
        };
        let mut url = url::Url::parse("otpauth-migration://offline").unwrap();
        url.query_pairs_mut().append_pair(
            "data",
            &general_purpose::STANDARD.encode(payload.encode_to_vec()),
        );
        url.to_string()
    }
    // Independent v2 wire fixture: public synthetic secrets, no batch_id field.
    pub(crate) fn v2_uri(index: u8, count: u8, start: u8) -> String {
        let mut bytes = Vec::new();
        for ordinal in start..start + count {
            let secret = format!("1234567890123456{ordinal:04}");
            let name = format!("Synthetic {ordinal}");
            let mut account = vec![0x0a, secret.len() as u8];
            account.extend(secret.as_bytes());
            account.extend([0x12, name.len() as u8]);
            account.extend(name.as_bytes());
            account.extend([0x1a, 7]);
            account.extend(b"Example");
            account.extend([0x20, 1, 0x28, 1, 0x30, 2]);
            bytes.extend([0x0a, account.len() as u8]);
            bytes.extend(account);
        }
        bytes.extend([0x10, 2, 0x18, 3, 0x20, index]);
        let mut url = url::Url::parse("otpauth-migration://offline").unwrap();
        url.query_pairs_mut()
            .append_pair("data", &general_purpose::STANDARD.encode(bytes));
        url.to_string()
    }
    #[test]
    fn ios_version_two_without_batch_id_collects_all_twenty_two_accounts() {
        let first = v2_uri(0, 10, 0);
        let middle = v2_uri(1, 10, 10);
        let last = v2_uri(2, 2, 20);
        assert_eq!(decode(&middle).unwrap().version, 2);
        assert_eq!(decode(&middle).unwrap().batch_id, 0);
        let partial = collect(&[last.clone(), first.clone(), last.clone()]).unwrap();
        assert_eq!(partial.progress.received, 2);
        assert_eq!(partial.progress.token_count, 12);
        assert_eq!(partial.progress.missing, vec![2]);
        assert_eq!(partial.progress.duplicate_codes, 1);
        assert!(!partial.progress.complete);
        let complete =
            collect(&[middle.clone(), last.clone(), first.clone(), middle.clone()]).unwrap();
        assert_eq!(complete.progress.received, 3);
        assert_eq!(complete.progress.token_count, 22);
        assert!(complete.progress.complete);
        assert_eq!(complete.tokens[0].name, "Synthetic 0");
        assert_eq!(complete.tokens[21].name, "Synthetic 21");
        assert!(complete
            .tokens
            .iter()
            .all(|t| t.kind == "totp" && t.algorithm == "SHA1" && t.digits == 6 && t.period == 30));
        assert_eq!(
            super::super::parse_import(
                [middle.clone(), last.clone(), first.clone()]
                    .join("\n")
                    .as_bytes(),
                None,
                "codes.txt"
            )
            .unwrap()
            .len(),
            22
        );
        // Missing numeric protobuf fields and explicitly encoded zero are equivalent.
        let mut payload = decode(&first).unwrap().encode_to_vec();
        payload.extend([0x28, 0]);
        let explicit_zero = format!(
            "otpauth-migration://offline?data={}",
            general_purpose::STANDARD.encode(payload)
        );
        assert_eq!(
            collect(&[first.clone(), explicit_zero])
                .unwrap()
                .progress
                .duplicate_codes,
            1
        );
        // Zero-ID exports still reject contradictory page contents, page counts, versions and IDs.
        let mut changed_id = decode(&middle).unwrap();
        changed_id.batch_id = 9;
        let changed_id = format!(
            "otpauth-migration://offline?data={}",
            general_purpose::STANDARD.encode(changed_id.encode_to_vec())
        );
        for incompatible in [
            v2_uri(0, 10, 1),
            uri(0, 3, 1, "v1"),
            changed_id,
            v2_uri(3, 1, 30),
        ] {
            assert!(collect(&[first.clone(), incompatible]).is_err());
        }
    }
    #[test]
    fn legacy_zero_and_one_versions_keep_their_compatibility() {
        let original = uri(7, 1, 0, "Legacy");
        for version in [0, 1] {
            let mut payload = decode(&original).unwrap();
            payload.version = version;
            let url = format!(
                "otpauth-migration://offline?data={}",
                general_purpose::STANDARD.encode(payload.encode_to_vec())
            );
            assert!(collect(&[url]).unwrap().progress.complete);
        }
    }
    #[test]
    fn out_of_order_pages_and_repeated_scans_require_every_page_before_import() {
        let first = uri(99, 3, 0, "first");
        let last = uri(99, 3, 2, "last");
        let partial = collect(&[last.clone(), first.clone(), first.clone()]).unwrap();
        assert_eq!(partial.progress.received, 2);
        assert_eq!(partial.progress.missing, vec![2]);
        assert_eq!(partial.progress.duplicate_codes, 1);
        assert!(!partial.progress.complete);
        assert!(super::super::parse_import(last.as_bytes(), None, "codes.txt").is_err());
        let all = [last, uri(99, 3, 1, "middle"), first];
        let complete = collect(&all).unwrap();
        assert!(complete.progress.complete);
        assert_eq!(
            complete
                .tokens
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "middle", "last"]
        );
        assert!(complete.tokens.iter().all(|t| t.kind == "hotp"
            && t.algorithm == "SHA512"
            && t.digits == 8
            && t.counter == 42));
        assert_eq!(
            super::super::parse_import(all.join("\n").as_bytes(), None, "codes.txt")
                .unwrap()
                .len(),
            3
        );
    }
    #[test]
    fn batches_cannot_be_mixed_or_replace_an_already_received_page() {
        let first = uri(99, 2, 0, "first");
        for other in [
            uri(100, 2, 1, "other batch"),
            uri(99, 3, 1, "other size"),
            uri(99, 2, 0, "changed page"),
            "otpauth://totp/Example?secret=GEZDGNBVGY3TQOJQ".into(),
        ] {
            assert!(collect(&[first.clone(), other]).is_err());
        }
    }
    #[test]
    fn protobuf_unknown_fields_and_base64_variants_remain_compatible() {
        let original = uri(-123, 1, 0, "Example");
        let payload = decode(&original).unwrap();
        let mut bytes = payload.encode_to_vec();
        // Forward-compatible unknown fixed32 field, handled by Prost.
        bytes.extend([0x55, 1, 2, 3, 4]);
        for encoded in [
            general_purpose::STANDARD.encode(&bytes),
            general_purpose::STANDARD_NO_PAD.encode(&bytes),
            general_purpose::URL_SAFE.encode(&bytes),
            general_purpose::URL_SAFE_NO_PAD.encode(&bytes),
        ] {
            let mut url = url::Url::parse("otpauth-migration://offline").unwrap();
            url.query_pairs_mut().append_pair("data", &encoded);
            assert!(collect(&[url.to_string()]).unwrap().progress.complete);
        }
        // Independent wire fixture: secret="1234567890", name="A", SHA1, 6 digits, TOTP,
        // version 1, one page, page zero and batch 7.
        let bytes = [
            0x0a, 0x15, 0x0a, 0x0a, b'1', b'2', b'3', b'4', b'5', b'6', b'7', b'8', b'9', b'0',
            0x12, 0x01, b'A', 0x20, 0x01, 0x28, 0x01, 0x30, 0x02, 0x10, 0x01, 0x18, 0x01, 0x28,
            0x07,
        ];
        let url = format!(
            "otpauth-migration://offline?data={}",
            general_purpose::STANDARD.encode(bytes)
        );
        let parsed = collect(&[url]).unwrap();
        assert_eq!(parsed.tokens[0].secret, b"1234567890");
        assert_eq!(parsed.tokens[0].name, "A");
        assert_eq!(parsed.tokens[0].period, 30);
    }
    #[test]
    fn invalid_metadata_algorithms_and_counter_are_rejected_without_echoing_payload() {
        for (size, index) in [(-1, 0), (129, 0), (2, -1), (2, 2), (0, 1)] {
            assert!(collect(&[uri(99, size, index, "synthetic-private-name")]).is_err());
        }
        let original = uri(99, 1, 0, "synthetic-private-name");
        for (algorithm, digits, counter, version) in [
            (4, 1, 0, 1),
            (1, 3, 0, 1),
            (1, 1, -1, 1),
            (1, 1, 0, 3),
            (1, 1, 0, -1),
        ] {
            let mut payload = decode(&original).unwrap();
            payload.accounts[0].algorithm = algorithm;
            payload.accounts[0].digits = digits;
            payload.accounts[0].counter = counter;
            payload.version = version;
            let url = format!(
                "otpauth-migration://offline?data={}",
                general_purpose::STANDARD.encode(payload.encode_to_vec())
            );
            let error = collect(&[url]).err().unwrap();
            assert!(!error.contains("synthetic-private-name"));
        }
        for invalid in [
            "otpauth-migration://example?data=AAAA",
            "otpauth-migration://offline?data=***",
            "https://example.com/private-token",
        ] {
            assert!(collect(&[invalid.into()]).is_err());
        }
    }
    #[test]
    fn ordinary_codes_preserve_hotp_and_repeat_scans_do_not_duplicate_entries() {
        let uri = "otpauth://hotp/Example:account?secret=GEZDGNBVGY3TQOJQ&issuer=Example&counter=53&digits=8&algorithm=SHA256".to_owned();
        let parsed = collect(&[uri.clone(), uri]).unwrap();
        assert_eq!(parsed.progress.received, 1);
        assert_eq!(parsed.progress.duplicate_codes, 1);
        assert_eq!(parsed.tokens[0].counter, 53);
        assert_eq!(parsed.tokens[0].issuer, "Example");
        assert_eq!(parsed.tokens[0].algorithm, "SHA256");
    }
}
