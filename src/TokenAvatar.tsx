import { t as translate } from "./i18n";
import { memo, useEffect, useRef, useState } from "react";
import { BookmarkPlus, Globe2, ImagePlus, Search, X } from "lucide-react";
import {
  faSteam,
  faGoogle,
  faGithub,
  faMicrosoft,
  faApple,
  faDiscord,
  faAmazon,
  faFacebook,
  faXTwitter,
  faDropbox,
  faReddit,
  faSpotify,
  faCloudflare,
  faGitlab,
  faBitbucket,
  faPaypal,
  faBattleNet,
  faInstagram,
  faLinkedin,
  faYahoo,
  faTwitch,
  faTelegram,
  faSlack,
  faWordpress,
  faFigma,
  faTiktok,
  faChrome,
  faGoogleDrive,
  faAndroid,
  faDocker,
  faDigitalOcean,
  faAws,
  faBitcoin,
  faNpm,
  faYandex,
  faUber,
  faVimeo,
  faMastodon,
  faPinterest,
  faYoutube,
  faUnity,
  faAtlassian,
  faSalesforce,
  faWeixin,
  faQq,
  faAlipay,
  faPlaystation,
  faXbox,
} from "@fortawesome/free-brands-svg-icons";
import { siSony, siEpicgames, siUbisoft, siEa, siRiotgames, siGogdotcom } from "simple-icons";
import type { SavedIcon, TokenView } from "./types";
import { api, errorText } from "./api";

type Brand = {
  id: string;
  name: string;
  color: string;
  icon: typeof faSteam | { path: string };
  aliases: string;
};
export const brands: Brand[] = [
  ["steam", "Steam", "#173b63", faSteam, "steam 蒸汽"],
  // A simple Joy-Con silhouette for Nintendo, which is not in the icon packages.
  ["nintendo", "Nintendo", "#e60012", { path: "M9 2H7a5 5 0 0 0-5 5v10a5 5 0 0 0 5 5h2V2zm-2 2v16a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm-1 3a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 6 7zm5-5v20h6a5 5 0 0 0 5-5V7a5 5 0 0 0-5-5h-6zm5.5 11a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5z" }, "nintendo nintendoswitch 任天堂 ns"],
  ["sony", "Sony", "#333333", siSony, "sony 索尼"],
  ["playstation", "PlayStation", "#006fcd", faPlaystation, "playstation playstationnetwork psn ps"],
  ["xbox", "Xbox", "#107c10", faXbox, "xbox xboxlive"],
  ["epicgames", "Epic Games", "#313131", siEpicgames, "epic epicgames 堡垒之夜"],
  ["ubisoft", "Ubisoft", "#2367d1", siUbisoft, "ubisoft uplay 育碧"],
  ["ea", "EA", "#e43229", siEa, "ea electronicarts origin"],
  ["riotgames", "Riot Games", "#eb0029", siRiotgames, "riot riotgames 拳头"],
  ["gog", "GOG", "#86328a", siGogdotcom, "gog gog.com"],
  ["google", "Google", "#4285f4", faGoogle, "google gmail 谷歌"],
  [
    "microsoft",
    "Microsoft",
    "#0878d4",
    faMicrosoft,
    "microsoft outlook office azure 微软",
  ],
  ["apple", "Apple", "#43484f", faApple, "apple icloud 苹果"],
  ["github", "GitHub", "#303741", faGithub, "github"],
  ["discord", "Discord", "#5865f2", faDiscord, "discord"],
  ["amazon", "Amazon", "#b96b00", faAmazon, "amazon 亚马逊"],
  ["aws", "AWS", "#c87800", faAws, "aws amazonwebservices"],
  ["facebook", "Facebook", "#1877f2", faFacebook, "facebook meta 脸书"],
  ["twitter", "X / Twitter", "#252a31", faXTwitter, "twitter x 推特"],
  ["instagram", "Instagram", "#c13584", faInstagram, "instagram"],
  ["linkedin", "LinkedIn", "#0a66c2", faLinkedin, "linkedin 领英"],
  ["dropbox", "Dropbox", "#0061ff", faDropbox, "dropbox"],
  ["reddit", "Reddit", "#e74c13", faReddit, "reddit"],
  ["spotify", "Spotify", "#168e40", faSpotify, "spotify"],
  ["cloudflare", "Cloudflare", "#da7e16", faCloudflare, "cloudflare"],
  ["gitlab", "GitLab", "#df5c2e", faGitlab, "gitlab"],
  ["bitbucket", "Bitbucket", "#1769c4", faBitbucket, "bitbucket"],
  ["paypal", "PayPal", "#1473ad", faPaypal, "paypal 贝宝"],
  [
    "battlenet",
    "Battle.net",
    "#148ac2",
    faBattleNet,
    "battlenet battle.net blizzard 暴雪 战网",
  ],
  ["yahoo", "Yahoo", "#6001d2", faYahoo, "yahoo 雅虎"],
  ["twitch", "Twitch", "#9146ff", faTwitch, "twitch"],
  ["telegram", "Telegram", "#2487ba", faTelegram, "telegram 电报"],
  ["slack", "Slack", "#61366a", faSlack, "slack"],
  ["wordpress", "WordPress", "#21759b", faWordpress, "wordpress"],
  ["figma", "Figma", "#b94e40", faFigma, "figma"],
  ["tiktok", "TikTok", "#303741", faTiktok, "tiktok 抖音"],
  ["chrome", "Chrome", "#3874bd", faChrome, "chrome"],
  [
    "googledrive",
    "Google Drive",
    "#148e63",
    faGoogleDrive,
    "googledrive 谷歌云盘",
  ],
  ["android", "Android", "#328d58", faAndroid, "android 安卓"],
  ["docker", "Docker", "#1687c4", faDocker, "docker"],
  ["digitalocean", "DigitalOcean", "#0080ff", faDigitalOcean, "digitalocean"],
  ["bitcoin", "Bitcoin", "#c87a11", faBitcoin, "bitcoin 比特币"],
  ["npm", "npm", "#bd3034", faNpm, "npm"],
  ["yandex", "Yandex", "#d13631", faYandex, "yandex"],
  ["uber", "Uber", "#303741", faUber, "uber 优步"],
  ["vimeo", "Vimeo", "#2488b3", faVimeo, "vimeo"],
  ["mastodon", "Mastodon", "#6364ff", faMastodon, "mastodon"],
  ["pinterest", "Pinterest", "#c8232c", faPinterest, "pinterest"],
  ["youtube", "YouTube", "#db3232", faYoutube, "youtube 油管"],
  ["unity", "Unity", "#444b55", faUnity, "unity"],
  [
    "atlassian",
    "Atlassian",
    "#1769c4",
    faAtlassian,
    "atlassian jira confluence",
  ],
  ["salesforce", "Salesforce", "#1587b5", faSalesforce, "salesforce"],
  ["wechat", "微信", "#199c4e", faWeixin, "wechat weixin 微信"],
  ["qq", "QQ", "#278bc5", faQq, "qq 腾讯"],
  ["alipay", "支付宝", "#1677ff", faAlipay, "alipay 支付宝"],
].map(([id, name, color, icon, aliases]) => ({
  id,
  name,
  color,
  icon,
  aliases,
})) as Brand[];
const normalized = (value: string) =>
  value.toLowerCase().replace(/[\s._:-]/g, "");
const brandIndex = brands.map((brand) => ({
  brand,
  normalizedAliases: brand.aliases.split(" ").map(normalized),
}));
const brandById = new Map(brands.map((brand) => [brand.id, brand]));
const automaticBrandCache = new Map<string, Brand | undefined>();

export function automaticBrand(
  token: Pick<TokenView, "kind" | "issuer" | "name">,
) {
  if (token.kind === "steam") return brands[0];
  const key = `${token.kind}\0${token.issuer}\0${token.name}`;
  if (automaticBrandCache.has(key)) return automaticBrandCache.get(key);
  const issuer = normalized(token.issuer);
  const name = normalized(token.name);
  const matched =
    brandIndex.find(({ normalizedAliases }) => normalizedAliases.includes(issuer))?.brand ??
    brandIndex.find(({ brand }) => brand.id.length > 2 && name.includes(brand.id))?.brand;
  if (automaticBrandCache.size > 512) automaticBrandCache.clear();
  automaticBrandCache.set(key, matched);
  return matched;
}

/** 根据令牌发行方或账户邮箱猜测服务官网域名，用于自动预填图标地址。 */
function guessWebsiteHost(token: Pick<TokenView, "issuer" | "name" | "accountName">): string {
  const raw = `${token.issuer || ""} ${token.accountName || ""} ${token.name || ""}`;
  const domainMatch = raw.match(/\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\b/i);
  if (domainMatch) return domainMatch[1].toLowerCase();
  const issuer = (token.issuer || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (issuer.length >= 2 && issuer !== "example") return `${issuer}.com`;
  return "";
}

export const TokenAvatar = memo(function TokenAvatar({
  token,
  icon = token.icon,
}: {
  token: Pick<TokenView, "kind" | "issuer" | "name" | "icon">;
  icon?: string | null;
}) {
  const brand = icon?.startsWith("brand:")
    ? brandById.get(icon.slice(6))
    : automaticBrand(token);
  if (icon?.startsWith("data:image/png;base64,"))
    return (
      <span className="token-avatar custom">
        <img src={icon} alt={translate("自定义头像")} />
      </span>
    );
  if (brand)
    return (
      <span
        className="token-avatar brand-avatar"
        style={{ color: brand.color }}
        aria-label={brand.name}
      >
        <svg
          viewBox={"icon" in brand.icon ? `0 0 ${brand.icon.icon[0]} ${brand.icon.icon[1]}` : "0 0 24 24"}
          aria-hidden="true"
        >
          {("icon" in brand.icon
            ? (Array.isArray(brand.icon.icon[4]) ? brand.icon.icon[4] : [brand.icon.icon[4]])
            : [brand.icon.path]
          ).map((path, i) => (
            <path key={i} d={path} fill="currentColor" fillRule={brand.id === "nintendo" ? "evenodd" : undefined} />
          ))}
        </svg>
      </span>
    );
  return (
    <span className="token-avatar initials" aria-hidden="true">
      {(token.issuer || token.name).trim().slice(0, 1).toUpperCase() || "#"}
    </span>
  );
});
async function imageAvatar(file: File) {
  if (file.size > 10 * 1024 * 1024)
    throw new Error(translate("请选择不超过 10 MB 的图片"));
  if (file.type === "image/svg+xml") throw new Error(translate("请选择 PNG、JPEG 或照片"));
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error(translate("无法打开图片，请使用 PNG 或 JPEG")));
      image.src = url;
    });
    if (
      !image.naturalWidth ||
      image.naturalWidth * image.naturalHeight > 40_000_000
    )
      throw new Error(translate("图片过大，请裁剪后重试"));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(translate("无法处理图片"));
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      96,
      96,
    );
    const result = canvas.toDataURL("image/png");
    context.clearRect(0, 0, 96, 96);
    canvas.width = canvas.height = 0;
    return result;
  } finally {
    image.src = "";
    URL.revokeObjectURL(url);
  }
}
/** 从输入的网址提取适合作为图标标签的主机名（去掉 www.）。 */
function labelFromWebsite(input: string, fallback: string): string {
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return parsed.hostname.replace(/^www\./i, "") || fallback;
  } catch {
    return trimmed.slice(0, 60) || fallback;
  }
}

export function IconPicker({
  token,
  selected,
  onSelect,
  onBack,
}: {
  token: TokenView;
  selected: string | null;
  onSelect: (icon: string | null) => void;
  onBack: () => void;
}) {
  const [search, setSearch] = useState("");
  const [websiteOpen, setWebsiteOpen] = useState(false);
  const [website, setWebsite] = useState("");
  const [websiteIcon, setWebsiteIcon] = useState<string | null>(null);
  const [savedIcons, setSavedIcons] = useState<SavedIcon[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void api
      .savedIcons()
      .then((items) => {
        if (live && Array.isArray(items)) setSavedIcons(items);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const persistSavedIcon = async (label: string, data: string) => {
    try {
      const saved = await api.savedIconSave(label, data);
      if (saved && typeof saved.id === "string") {
        setSavedIcons((prev) => [saved, ...prev.filter((item) => item.id !== saved.id && item.data !== saved.data)]);
      }
    } catch {
      /* 图标库保存失败或预览环境下无原生接口时，仍允许正常使用当前头像。 */
    }
  };

  const fetchWebsiteIcon = async () => {
    if (busy || !website.trim()) return;
    setBusy(true);
    setWebsiteIcon(null);
    setError("");
    try {
      setWebsiteIcon(await api.avatarFromWebsite(website));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const removeSavedIcon = async (item: SavedIcon) => {
    setBusy(true);
    setError("");
    try {
      const next = await api.savedIconDelete(item.id);
      setSavedIcons(Array.isArray(next) ? next : savedIcons.filter((row) => row.id !== item.id));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const normalizedSearch = search.trim().toLowerCase();
  const filteredSaved = savedIcons.filter((item) =>
    !normalizedSearch || item.label.toLowerCase().includes(normalizedSearch),
  );
  const filteredBrands = brands.filter((brand) =>
    `${brand.name} ${brand.aliases}`.toLowerCase().includes(normalizedSearch),
  );

  return (
    <div className="icon-picker">
      <div className="icon-picker-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={() => onSelect(null)}>{translate("自动图标")}</button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <ImagePlus size={17} />{translate("自定义头像")}</button>
        <button type="button" className="button secondary" disabled={busy} aria-expanded={websiteOpen} onClick={() => setWebsiteOpen(open => {
          const next = !open;
          if (next && !website) setWebsite(guessWebsiteHost(token));
          return next;
        })}>
          <Globe2 size={17} />{translate("从网站获取")}</button>
        <input
          type="file"
          ref={picker}
          accept="image/*"
          className="visually-hidden"
          aria-label={translate("上传头像")}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setBusy(true);
            setError("");
            try {
              const data = await imageAvatar(file);
              const label = file.name.replace(/\.[^.]+$/, "").trim() || token.issuer || token.name;
              await persistSavedIcon(label, data);
              onSelect(data);
            } catch (error) {
              setError(errorText(error));
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
      {websiteOpen && <div className="website-icon-form">
        <label className="field-label" htmlFor="avatar-website">{translate("服务官网地址")}</label>
        <input id="avatar-website" type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2048}
          placeholder="https://example.com" disabled={busy} value={website} onChange={event => {
            setWebsite(event.target.value);
            setWebsiteIcon(null);
            setError("");
          }} onKeyDown={event => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            void fetchWebsiteIcon();
          }} />
        <div className="icon-picker-actions">
          <button type="button" className="button secondary" disabled={busy || !website.trim()} onClick={() => void fetchWebsiteIcon()}>
            {busy ? translate("正在获取图标…") : translate("获取图标")}
          </button>
          {websiteIcon && <>
            <TokenAvatar token={token} icon={websiteIcon} />
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await persistSavedIcon(labelFromWebsite(website, token.issuer || token.name), websiteIcon);
                  onSelect(websiteIcon);
                } finally {
                  setBusy(false);
                }
              }}
            >{translate("使用此图标")}</button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const saved = await api.savedIconSave(labelFromWebsite(website, token.issuer || token.name), websiteIcon);
                  if (saved && typeof saved.id === "string") {
                    setSavedIcons((prev) => [saved, ...prev.filter((item) => item.id !== saved.id && item.data !== saved.data)]);
                  }
                } catch (err) {
                  setError(errorText(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <BookmarkPlus size={15} />
              {translate("保存到图标库")}
            </button>
          </>}
        </div>
      </div>}
      <label className="icon-search">
        <Search size={17} />
        <input
          aria-label={translate("搜索图标")}
          placeholder={translate("搜索服务")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {filteredSaved.length > 0 && (
        <div className="saved-icons-section">
          <div className="icon-section-title">{translate("已保存图标")}</div>
          <div className="icon-options saved-icon-options" role="group" aria-label={translate("已保存图标")}>
            {filteredSaved.map((item) => (
              <div className="saved-icon-item" key={item.id}>
                <button
                  type="button"
                  className={selected === item.data ? "selected" : ""}
                  aria-label={translate("选择 {{name}} 图标", { name: item.label })}
                  disabled={busy}
                  onClick={() => onSelect(item.data)}
                >
                  <TokenAvatar token={token} icon={item.data} />
                  <span>{item.label}</span>
                </button>
                <button
                  type="button"
                  className="saved-icon-delete"
                  aria-label={translate("删除图标 {{name}}", { name: item.label })}
                  title={translate("删除")}
                  disabled={busy}
                  onClick={() => void removeSavedIcon(item)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="icon-options" role="group" aria-label={translate("服务图标")}>
        {filteredBrands.map((brand) => (
            <button
              type="button"
              key={brand.id}
              className={selected === `brand:${brand.id}` ? "selected" : ""}
              aria-label={translate("选择 {{name}} 图标", { name: brand.name })}
              disabled={busy}
              onClick={() => onSelect(`brand:${brand.id}`)}
            >
              <TokenAvatar token={token} icon={`brand:${brand.id}`} />
              <span>{brand.name}</span>
            </button>
          ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="button secondary" onClick={onBack}>{translate("返回")}</button>
      </div>
    </div>
  );
}
