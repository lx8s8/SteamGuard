//! Exact WattToolkit MemoryPack schema readers, verified against the official .NET serializer.
//! No general-purpose deserialization, untrusted lengths never drive unbounded allocation.
use super::{
    legacy::{SecretToken, SecretTokens},
    Mp, Token, MAX_IMPORT_BYTES, MAX_RECORDS,
};
use zeroize::Zeroizing;

const INVALID: &str = "WattToolkit MemoryPack 文件损坏或结构不兼容";

pub(super) fn detect(data: &[u8], password: Option<&str>) -> Option<Result<Vec<Token>, String>> {
    let list = data
        .get(..4)
        .and_then(|v| v.try_into().ok())
        .map(i32::from_le_bytes)
        .is_some_and(|n| (1..=MAX_RECORDS as i32).contains(&n))
        && matches!(data.get(4), Some(8 | 11));
    if !list && !matches!(data.first(), Some(8 | 11)) {
        return None;
    }
    let result = parse(data, password, list);
    // An extreme Index value can make a single account's first bytes resemble
    // a list header. Accept only a complete parse of either exact schema.
    Some(
        if result.is_err() && list && matches!(data.first(), Some(8 | 11)) {
            parse(data, password, false)
        } else {
            result
        },
    )
}

fn parse(data: &[u8], password: Option<&str>, list: bool) -> Result<Vec<Token>, String> {
    let mut reader = Reader { data, offset: 0 };
    let count = if list { reader.i32()? as usize } else { 1 };
    let schema = *reader.data.get(reader.offset).ok_or(INVALID)?;
    let mut tokens = SecretTokens::default();
    let mut accounts = Vec::new();
    for _ in 0..count {
        if reader.u8()? != schema {
            return Err(INVALID.into());
        }
        match schema {
            11 => tokens.0.push(dto(&mut reader)?),
            8 => accounts.push(account(&mut reader)?),
            _ => return Err("不支持的 WattToolkit MemoryPack 数据版本".into()),
        }
    }
    if reader.offset != data.len() {
        return Err(INVALID.into());
    }
    if schema == 8 {
        super::import_watt_rows(Mp::Array(accounts), password)
    } else {
        Ok(std::mem::take(&mut tokens.0))
    }
}

fn dto(reader: &mut Reader<'_>) -> Result<Token, String> {
    let platform = reader.u8()?;
    let kind = match platform {
        1 => "steam",
        5 | 12 | 14 => "totp",
        11 => "battlenet",
        13 => "hotp",
        _ => return Err("导出包含暂不支持的令牌平台".into()),
    };
    let issuer = reader.string()?;
    let algorithm = match reader.i32()? {
        0 => "SHA1",
        1 => "SHA256",
        2 => "SHA512",
        _ => return Err("未知的令牌哈希算法".into()),
    };
    let serial = reader.string()?;
    let device_id = reader.string()?;
    let steam_data = reader.string()?;
    let counter = u64::try_from(reader.i64()?).map_err(|_| INVALID)?;
    let period = match reader.i32()? {
        0 => 30,
        value => u64::try_from(value).map_err(|_| INVALID)?,
    };
    let mut secret = reader.bytes()?.ok_or("令牌密钥缺失")?;
    let digits = u32::try_from(reader.i32()?).map_err(|_| INVALID)?;
    let name = reader.string()?.ok_or(INVALID)?;
    let mut token = SecretToken::new(Token::new(
        name.to_string(),
        kind.into(),
        std::mem::take(&mut *secret),
    ));
    token.issuer = issuer.map(|v| v.to_string()).unwrap_or_else(|| {
        if kind == "steam" {
            "Steam".into()
        } else {
            String::new()
        }
    });
    token.algorithm = algorithm.into();
    token.counter = counter;
    token.period = period;
    token.digits = digits;
    token.device_id = device_id.map(|v| v.to_string());
    if let Some(data) = steam_data.filter(|v| !v.is_empty()) {
        let mut value = super::encrypted::SecretJson(
            serde_json::from_str(&data).map_err(|_| "Steam 令牌附加数据损坏")?,
        );
        if !value.0.is_object() {
            return Err("Steam 令牌附加数据损坏".into());
        }
        super::apply_steam_data(&mut token, &value.0);
        token.steam_data = Some(std::mem::take(&mut value.0));
    } else if kind == "battlenet" {
        if let Some(serial) = serial {
            token.steam_data = Some(serde_json::json!({"serial": serial.to_string()}));
        }
    }
    super::validate_token(&token)?;
    Ok(token.take())
}

fn account(reader: &mut Reader<'_>) -> Result<Mp, String> {
    let index = reader.i32()?;
    let mut name = reader.bytes()?.ok_or("导出记录缺少名称")?;
    let mut value = reader.bytes()?.ok_or("导出记录缺少令牌数据")?;
    let portable = reader.boolean()?;
    let password = reader.boolean()?;
    // .NET 7+ unmanaged layouts: DateTimeOffset is 16 bytes, Nullable<Guid> 20.
    // These fields do not affect token identity; still consume the exact schema.
    reader.take(16 + 16 + 20)?;
    Ok(super::mp_map(vec![
        ("Index", Mp::from(index)),
        ("Name", Mp::Binary(std::mem::take(&mut *name))),
        ("Value", Mp::Binary(std::mem::take(&mut *value))),
        ("IsNotLocal", Mp::from(portable)),
        ("IsNeedSecondaryPassword", Mp::from(password)),
    ]))
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(count)
            .filter(|n| *n <= self.data.len())
            .ok_or(INVALID)?;
        let value = &self.data[self.offset..end];
        self.offset = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn boolean(&mut self) -> Result<bool, String> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(INVALID.into()),
        }
    }
    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn bytes(&mut self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        let length = self.i32()?;
        if length == -1 {
            return Ok(None);
        }
        let length = usize::try_from(length).map_err(|_| INVALID)?;
        if length > MAX_IMPORT_BYTES {
            return Err(INVALID.into());
        }
        Ok(Some(Zeroizing::new(self.take(length)?.to_vec())))
    }
    fn string(&mut self) -> Result<Option<Zeroizing<String>>, String> {
        let length = self.i32()?;
        if length == -1 {
            return Ok(None);
        }
        let value = if length < -1 {
            let byte_count = (!length) as usize;
            let utf16_length = self.i32()?;
            if byte_count > MAX_IMPORT_BYTES || utf16_length < -1 {
                return Err(INVALID.into());
            }
            let text = std::str::from_utf8(self.take(byte_count)?).map_err(|_| INVALID)?;
            if utf16_length >= 0 && text.encode_utf16().count() != utf16_length as usize {
                return Err(INVALID.into());
            }
            text.to_owned()
        } else {
            let byte_count = (length as usize)
                .checked_mul(2)
                .filter(|n| *n <= MAX_IMPORT_BYTES)
                .ok_or(INVALID)?;
            let units = Zeroizing::new(
                self.take(byte_count)?
                    .chunks_exact(2)
                    .map(|v| u16::from_le_bytes([v[0], v[1]]))
                    .collect::<Vec<_>>(),
            );
            String::from_utf16(&units).map_err(|_| INVALID)?
        };
        Ok(Some(Zeroizing::new(value)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::parse_import;
    const DTO: &[u8] = include_bytes!("fixtures/memorypack-dto.bin");
    const UTF16: &[u8] = include_bytes!("fixtures/memorypack-dto-utf16.bin");
    const LIST: &[u8] = include_bytes!("fixtures/memorypack-dto-list.bin");
    const ACCOUNT: &[u8] = include_bytes!("fixtures/memorypack-account.bin");
    const ACCOUNTS: &[u8] = include_bytes!("fixtures/memorypack-accounts.bin");

    #[test]
    fn official_serializer_dto_single_utf16_and_list_preserve_steam_hotp_fields() {
        for data in [DTO, UTF16, LIST] {
            let tokens = parse_import(data, None, "fixture.mpo").unwrap();
            assert_eq!(tokens[0].name, "MemoryPack Ω");
            assert_eq!(tokens[0].secret, b"12345678901234567890");
            assert_eq!(tokens[0].kind, "steam");
            assert_eq!(tokens[0].steam_id.as_deref(), Some("76561198000000001"));
            assert_eq!(tokens[0].identity_secret.as_deref(), Some("aWRlbnRpdHk="));
            assert_eq!(tokens[0].device_id.as_deref(), Some("android:fixture"));
            if data == LIST {
                assert_eq!(tokens.len(), 2);
                assert_eq!(tokens[1].kind, "hotp");
                assert_eq!(tokens[1].counter, 37);
                assert_eq!(tokens[1].algorithm, "SHA512");
                assert_eq!(tokens[1].period, 45);
            }
        }
    }

    #[test]
    fn official_serializer_account_single_and_list_use_original_aes_and_messagepack() {
        for data in [ACCOUNT, ACCOUNTS] {
            let tokens = parse_import(data, None, "fixture.mpo").unwrap();
            assert_eq!(tokens.len(), 1);
            assert_eq!(tokens[0].name, "MemoryPack account");
            assert_eq!(tokens[0].secret, b"1234567890");
            assert_eq!(tokens[0].kind, "totp");
        }
        let mut ambiguous = ACCOUNT.to_vec();
        ambiguous[1..5].copy_from_slice(&0x0800_0000i32.to_le_bytes());
        assert_eq!(
            parse_import(&ambiguous, None, "fixture.mpo").unwrap().len(),
            1
        );
    }

    #[test]
    fn truncated_trailing_unknown_schema_and_forged_lengths_are_rejected() {
        for data in [DTO, UTF16, LIST, ACCOUNT, ACCOUNTS] {
            for end in 0..data.len() {
                assert!(parse_import(&data[..end], None, "fixture.mpo").is_err());
            }
            let mut trailing = data.to_vec();
            trailing.push(0);
            assert!(parse_import(&trailing, None, "fixture.mpo").is_err());
        }
        let mut invalid = DTO.to_vec();
        invalid[0] = 12;
        assert!(parse_import(&invalid, None, "fixture.mpo").is_err());
        let mut invalid = DTO.to_vec();
        invalid[2..6].copy_from_slice(&i32::MIN.to_le_bytes());
        assert!(parse_import(&invalid, None, "fixture.mpo").is_err());
        let mut invalid = ACCOUNTS.to_vec();
        invalid[0..4].copy_from_slice(&i32::MAX.to_le_bytes());
        assert!(parse_import(&invalid, None, "fixture.mpo").is_err());
        let mut reader = Reader {
            data: &[1, 0, 0, 0, 0x00, 0xD8],
            offset: 0,
        };
        assert!(reader.string().is_err());
    }
}
