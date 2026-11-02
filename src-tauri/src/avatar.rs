//! Offline token artwork. Only bundled brand identifiers and small PNGs are accepted.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageFormat, ImageReader, Limits};
use std::io::Cursor;

const PREFIX: &str = "data:image/png;base64,";
const MAX_BYTES: usize = 48 * 1024;
fn decode(value: &str) -> Result<image::DynamicImage, String> {
    let encoded = value.strip_prefix(PREFIX).ok_or("头像格式无效")?;
    if encoded.len() > MAX_BYTES * 4 / 3 + 4 {
        return Err("头像文件过大".into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| "头像编码无效")?;
    if bytes.len() > MAX_BYTES {
        return Err("头像文件过大".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(128);
    limits.max_image_height = Some(128);
    limits.max_alloc = Some(2 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "头像图片无效，请重新选择".into())
}
pub fn validate(value: &str) -> Result<(), String> {
    if let Some(slug) = value.strip_prefix("brand:") {
        if !slug.is_empty()
            && slug.len() <= 64
            && slug
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Ok(());
        }
        return Err("图标编号无效".into());
    }
    decode(value)?;
    Ok(())
}
pub fn normalize(value: &str) -> Result<String, String> {
    if value.starts_with("brand:") {
        validate(value)?;
        return Ok(value.into());
    }
    let image = decode(value)?.resize_to_fill(96, 96, image::imageops::FilterType::Triangle);
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|_| "无法保存头像")?;
    if bytes.get_ref().len() > MAX_BYTES {
        return Err("头像文件过大".into());
    }
    Ok(format!("{PREFIX}{}", STANDARD.encode(bytes.into_inner())))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_bundled_icons_and_normalizes_bounded_png_without_remote_urls() {
        validate("brand:steam").unwrap();
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(32, 64)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let avatar =
            normalize(&format!("{PREFIX}{}", STANDARD.encode(bytes.into_inner()))).unwrap();
        let image = decode(&avatar).unwrap();
        assert_eq!((image.width(), image.height()), (96, 96));
        for invalid in [
            "https://example.com/avatar.png",
            "data:image/svg+xml,<svg/>",
            "brand:../private",
            "data:image/png;base64,AAAA",
        ] {
            assert!(validate(invalid).is_err());
        }
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(129, 1)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        assert!(validate(&format!("{PREFIX}{}", STANDARD.encode(bytes.into_inner()))).is_err());
    }
}
