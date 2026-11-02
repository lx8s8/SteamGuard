import { t as translate } from "./i18n";
import { useRef, useState } from "react";
import { ImagePlus, Search } from "lucide-react";
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
} from "@fortawesome/free-brands-svg-icons";
import type { TokenView } from "./types";
import { errorText } from "./api";

type Brand = {
  id: string;
  name: string;
  color: string;
  icon: typeof faSteam;
  aliases: string;
};
export const brands: Brand[] = [
  ["steam", "Steam", "#173b63", faSteam, "steam 蒸汽"],
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
export function automaticBrand(
  token: Pick<TokenView, "kind" | "issuer" | "name">,
) {
  if (token.kind === "steam") return brands[0];
  const issuer = normalized(token.issuer);
  return (
    brands.find((brand) =>
      brand.aliases.split(" ").some((alias) => normalized(alias) === issuer),
    ) ??
    brands.find(
      (brand) =>
        brand.id.length > 2 && normalized(token.name).includes(brand.id),
    )
  );
}
export function TokenAvatar({
  token,
  icon = token.icon,
}: {
  token: Pick<TokenView, "kind" | "issuer" | "name" | "icon">;
  icon?: string | null;
}) {
  const brand = icon?.startsWith("brand:")
    ? brands.find((brand) => brand.id === icon.slice(6))
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
          viewBox={`0 0 ${brand.icon.icon[0]} ${brand.icon.icon[1]}`}
          aria-hidden="true"
        >
          {(Array.isArray(brand.icon.icon[4])
            ? brand.icon.icon[4]
            : [brand.icon.icon[4]]
          ).map((path, i) => (
            <path key={i} d={path} fill="currentColor" />
          ))}
        </svg>
      </span>
    );
  return (
    <span className="token-avatar initials" aria-hidden="true">
      {(token.issuer || token.name).trim().slice(0, 1).toUpperCase() || "#"}
    </span>
  );
}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div className="icon-picker">
      <div className="icon-picker-actions">
        <button className="button secondary" onClick={() => onSelect(null)}>{translate("自动图标")}</button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <ImagePlus size={17} />{translate("自定义头像")}</button>
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
              onSelect(await imageAvatar(file));
            } catch (error) {
              setError(errorText(error));
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
      <label className="icon-search">
        <Search size={17} />
        <input
          aria-label={translate("搜索图标")}
          placeholder={translate("搜索服务")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="icon-options" role="group" aria-label={translate("服务图标")}>
        {brands
          .filter((brand) =>
            `${brand.name} ${brand.aliases}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((brand) => (
            <button
              key={brand.id}
              className={selected === `brand:${brand.id}` ? "selected" : ""}
              aria-label={translate("选择 {{name}} 图标", { name: brand.name })}
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
        <button className="button secondary" onClick={onBack}>{translate("返回")}</button>
      </div>
    </div>
  );
}
