use html5ever::{
    tendril::StrTendril,
    tokenizer::{
        states::RawKind, BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer,
        TokenizerOpts,
    },
};
use image::{ImageFormat, ImageReader, Limits};
use std::{cell::RefCell, collections::HashSet, io::Cursor, net::IpAddr, time::Duration};
use url::Url;

const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const FETCH_ERROR: &str = "未找到可用的网站图标，请检查官网地址或上传图片";
const URL_ERROR: &str = "请输入公开的 HTTPS 网站地址";

#[tauri::command]
pub async fn avatar_from_website(
    s: tauri::State<'_, crate::AppState>,
    website: String,
) -> Result<String, String> {
    s.unlocked()?;
    let epoch = s.epoch.load(std::sync::atomic::Ordering::SeqCst);
    let url = parse_website(&website)?;
    let icon = tokio::time::timeout(Duration::from_secs(18), fetch_icon(url))
        .await
        .map_err(|_| FETCH_ERROR)??;
    s.unlocked()?;
    if epoch != s.epoch.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("保险库状态已变化，请重试".into());
    }
    Ok(icon)
}

fn parse_website(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() || input.len() > 2048 {
        return Err(URL_ERROR.into());
    }
    let mut url = if input.contains("://") {
        Url::parse(input)
    } else {
        Url::parse(&format!("https://{input}"))
    }
    .map_err(|_| URL_ERROR)?;
    url.set_query(None);
    url.set_fragment(None);
    website_host(&url)?;
    Ok(url)
}

fn website_host(url: &Url) -> Result<&str, String> {
    let host = url.domain().ok_or(URL_ERROR)?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !host.trim_end_matches('.').contains('.')
        || url.as_str().len() > 2048
    {
        return Err(URL_ERROR.into());
    }
    Ok(host)
}

fn public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => !matches!(
            ip.octets(),
            [0 | 10 | 127 | 224..=255, ..]
                | [100, 64..=127, ..]
                | [169, 254, ..]
                | [172, 16..=31, ..]
                | [192, 0, ..]
                | [192, 88, 99, _]
                | [192, 168, ..]
                | [198, 18..=19, ..]
                | [198, 51, 100, _]
                | [203, 0, 113, _]
        ),
        IpAddr::V6(ip) => {
            let [first, second, ..] = ip.segments();
            (0x2000..0x4000).contains(&first)
                && !matches!(
                    (first, second),
                    (0x2001, 0..=0x1ff | 0x0db8) | (0x2002, _) | (0x3fff, 0..=0x0fff)
                )
        }
    }
}

async fn fetch(mut url: Url) -> Result<(Url, Vec<u8>), String> {
    for _ in 0..=4 {
        let host = website_host(&url)?;
        let addresses: Vec<_> = tokio::net::lookup_host((host, 443))
            .await
            .map_err(|_| FETCH_ERROR)?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|addr| !public_address(addr.ip())) {
            return Err(URL_ERROR.into());
        }
        // Pin the validated addresses for this request, including every redirect target.
        let client = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .user_agent("SteamGuard/WebsiteIcons (+https://github.com/lx8s8/SteamGuard)")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(6))
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| FETCH_ERROR)?;
        let mut response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| FETCH_ERROR)?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(FETCH_ERROR)?;
            url = url.join(location).map_err(|_| FETCH_ERROR)?;
            url.set_fragment(None);
            continue;
        }
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
        {
            return Err(FETCH_ERROR.into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| FETCH_ERROR)? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(FETCH_ERROR.into());
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((url, bytes));
    }
    Err(FETCH_ERROR.into())
}

#[derive(Default)]
struct Links(RefCell<Vec<(u32, String)>>);
impl TokenSink for Links {
    type Handle = ();

    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        let Token::TagToken(tag) = token else {
            return TokenSinkResult::Continue;
        };
        if tag.kind != TagKind::StartTag {
            return TokenSinkResult::Continue;
        }
        match tag.name.as_ref() {
            "script" => return TokenSinkResult::RawData(RawKind::ScriptData),
            "style" => return TokenSinkResult::RawData(RawKind::Rawtext),
            "link" => {}
            _ => return TokenSinkResult::Continue,
        }
        let attr = |name| {
            tag.attrs
                .iter()
                .find(|a| a.name.local.as_ref() == name)
                .map(|a| a.value.as_ref())
        };
        let rel = attr("rel").unwrap_or_default();
        if rel.split_ascii_whitespace().any(|part| {
            matches!(
                part.to_ascii_lowercase().as_str(),
                "icon" | "apple-touch-icon" | "apple-touch-icon-precomposed"
            )
        }) {
            if let Some(href) = attr("href").filter(|href| href.len() <= 2048) {
                let size = attr("sizes")
                    .unwrap_or_default()
                    .split_ascii_whitespace()
                    .filter_map(|size| size.split_once(['x', 'X']))
                    .filter_map(|(w, h)| Some(w.parse::<u32>().ok()?.min(h.parse::<u32>().ok()?)))
                    .max()
                    .unwrap_or(0);
                self.0.borrow_mut().push((size, href.into()));
            }
        }
        TokenSinkResult::Continue
    }
}

fn candidates(page: &Url, html: &[u8]) -> Vec<Url> {
    let contents = String::from_utf8_lossy(html);
    let input = BufferQueue::default();
    input.push_back(StrTendril::from(contents.as_ref()));
    let parser = Tokenizer::new(Links::default(), TokenizerOpts::default());
    let _ = parser.feed(&input);
    parser.end();
    let mut links = parser.sink.0.into_inner();
    links.sort_by_key(|(size, _)| std::cmp::Reverse(*size));
    let fallback = page.join("/favicon.ico").ok();
    let mut seen = HashSet::new();
    links
        .into_iter()
        .filter_map(|(_, href)| page.join(&href).ok())
        .filter(|url| {
            Some(url) != fallback.as_ref() && website_host(url).is_ok() && seen.insert(url.clone())
        })
        .take(4)
        .chain(fallback.iter().cloned())
        .collect()
}

fn rasterize(bytes: &[u8]) -> Option<String> {
    let format = image::guess_format(bytes).ok()?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Ico | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return None;
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_height = Some(1024);
    limits.max_image_width = Some(1024);
    limits.max_alloc = Some(8 * 1024 * 1024);
    reader.limits(limits);
    crate::avatar::encode_png(reader.decode().ok()?).ok()
}

async fn fetch_icon(url: Url) -> Result<String, String> {
    let (page, bytes) = fetch(url).await?;
    if let Some(avatar) = rasterize(&bytes) {
        return Ok(avatar);
    }
    for candidate in candidates(&page, &bytes) {
        if let Ok((_, bytes)) = fetch(candidate).await {
            if let Some(avatar) = rasterize(&bytes) {
                return Ok(avatar);
            }
        }
    }
    Err(FETCH_ERROR.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_public_requests_and_strips_page_tracking_data() {
        for address in [
            "http://example.com",
            "https://127.0.0.1",
            "https://localhost",
            "https://[::1]",
            "https://example.com:8443",
            "https://user:pass@example.com",
        ] {
            assert!(parse_website(address).is_err());
        }
        assert_eq!(
            parse_website("example.com/a?tracking=yes#fragment")
                .unwrap()
                .as_str(),
            "https://example.com/a"
        );
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "192.168.0.1",
            "100.64.0.1",
            "::ffff:127.0.0.1",
            "fd00::1",
            "2002:7f00:1::1",
        ] {
            assert!(!public_address(ip.parse().unwrap()));
        }
        assert!(public_address("8.8.8.8".parse().unwrap()));
        assert!(public_address("2606:4700::1111".parse().unwrap()));
    }

    #[test]
    fn extracts_real_icon_links_and_normalizes_raster_images() {
        let page = parse_website("example.com/service/page").unwrap();
        let html = br#"<script>const ignored = '<link rel=icon href=/wrong.png>';</script>
            <link rel='shortcut icon' href='small.ico' sizes='16x16'>
            <LINK REL='Apple-Touch-Icon' sizes='180x180' HREF='//cdn.example.com/brand.png?v=1&amp;size=180'>
            <link rel=icon href='http://example.com/invalid.png'>"#;
        assert_eq!(
            candidates(&page, html)
                .iter()
                .map(Url::as_str)
                .collect::<Vec<_>>(),
            [
                "https://cdn.example.com/brand.png?v=1&size=180",
                "https://example.com/service/small.ico",
                "https://example.com/favicon.ico",
            ]
        );
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(256, 256)
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        crate::avatar::validate(&rasterize(png.get_ref()).unwrap()).unwrap();
        assert!(rasterize(b"not an image").is_none());
    }

    #[tokio::test]
    #[ignore = "requires public HTTPS access"]
    async fn fetches_an_official_website_icon() {
        let icon = fetch_icon(parse_website("https://www.wikipedia.org/").unwrap())
            .await
            .unwrap();
        crate::avatar::validate(&icon).unwrap();
    }
}
