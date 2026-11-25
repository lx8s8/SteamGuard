import { t as translate } from "./i18n";
import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  faOpenai,
  faMeta,
  faBrave,
} from "@fortawesome/free-brands-svg-icons";
import {
  // 游戏平台
  siSony,
  siEpicgames,
  siUbisoft,
  siEa,
  siRiotgames,
  siGogdotcom,
  siMihoyo,
  siRockstargames,
  siRoblox,
  siActivision,
  siSquareenix,
  siSega,
  siKonami,
  siKick,
  // 加密货币交易所
  siBinance,
  siOkx,
  siCoinbase,
  siKucoin,
  siWazirx,
  // 加密钱包与公链生态
  siTrezor,
  siWalletconnect,
  siKeystone,
  siBlockchaindotcom,
  siEthereum,
  siSolana,
  siTether,
  siOpensea,
  // 券商、跨境金融与银行
  siRobinhood,
  siTradingview,
  siZerodha,
  siRakuten,
  siWise,
  siRevolut,
  siStripe,
  siPayoneer,
  siBrex,
  siCashapp,
  siVenmo,
  siSquare,
  siKlarna,
  siPaddle,
  siLemonsqueezy,
  siHsbc,
  siChase,
  siBankofamerica,
  siWellsfargo,
  siBarclays,
  siMonzo,
  siN26,
  siStarlingbank,
  siBunq,
  siNubank,
  siDeutschebank,
  // AI 工具
  siAnthropic,
  siClaude,
  siDeepseek,
  siPerplexity,
  siCursor,
  siHuggingface,
  siMistralai,
  siGooglegemini,
  // 密码管理、安全与邮箱
  si1password,
  siBitwarden,
  siLastpass,
  siDashlane,
  siKeeper,
  siProton,
  siProtonmail,
  siTuta,
  siZoho,
  siOkta,
  siAuth0,
  siYubico,
  siIcloud,
  // 云服务、VPS、域名、NAS 与开发
  siAlibabacloud,
  siHuawei,
  siGooglecloud,
  siVercel,
  siNetlify,
  siSupabase,
  siFirebase,
  siHetzner,
  siVultr,
  siOvh,
  siScaleway,
  siFlydotio,
  siRailway,
  siRender,
  siAkamai,
  siNamecheap,
  siGodaddy,
  siPorkbun,
  siGandi,
  siSquarespace,
  siShopify,
  siNotion,
  siLinear,
  siObsidian,
  siJetbrains,
  siPostman,
  siSentry,
  siDatadog,
  siGrafana,
  siSynology,
  siQnap,
  siProxmox,
  siUnraid,
  siTailscale,
  siUbiquiti,
  siMikrotik,
  siHomeassistant,
  siPlex,
  siJellyfin,
  siNordvpn,
  siExpressvpn,
  siMullvad,
  siSurfshark,
  // 社交、内容、硬件与国内常用
  siNetflix,
  siPatreon,
  siSubstack,
  siZoom,
  siWhatsapp,
  siSignal,
  siLine,
  siKakaotalk,
  siSnapchat,
  siThreads,
  siBluesky,
  siEbay,
  siEtsy,
  siAliexpress,
  siAirbnb,
  siTesla,
  siNvidia,
  siSamsung,
  siXiaomi,
  siDji,
  siBilibili,
  siZhihu,
  siXiaohongshu,
  siTaobao,
  siMeituan,
  siBaidu,
  siBytedance,
} from "simple-icons";
import { customBrandIcons, type CustomBrandIcon } from "./customBrandIcons";
import type { SavedIcon, TokenView } from "./types";
import { api, errorText } from "./api";

export type BrandCategory =
  | "exchange"
  | "wallet"
  | "finance"
  | "game"
  | "cloud"
  | "ai"
  | "security"
  | "social";

type BrandIconAsset = typeof faSteam | { path: string } | CustomBrandIcon;

export type Brand = {
  id: string;
  name: string;
  color: string;
  icon: BrandIconAsset;
  aliases: string;
  category: BrandCategory;
};

type BrandRow = readonly [
  id: string,
  name: string,
  color: string,
  icon: BrandIconAsset,
  aliases: string,
  category: BrandCategory,
];

// 品牌图标注册表：保留原有 55 个 ID 不变，并扩充主流交易所、钱包、券商及高频 2FA 服务。
// 亮色品牌已针对浅灰底色（--brand-surface）做对比度压深，保证深浅主题下都清晰可辨。
const brandRows: readonly BrandRow[] = [
  // === 游戏平台 ===
  ["steam", "Steam", "#173b63", faSteam, "steam 蒸汽", "game"],
  ["nintendo", "Nintendo", "#e60012", customBrandIcons.nintendo, "nintendo nintendoswitch 任天堂 ns", "game"],
  ["sony", "Sony", "#333333", siSony, "sony 索尼", "game"],
  ["playstation", "PlayStation", "#006fcd", faPlaystation, "playstation playstationnetwork psn ps", "game"],
  ["xbox", "Xbox", "#107c10", faXbox, "xbox xboxlive", "game"],
  ["epicgames", "Epic Games", "#313131", siEpicgames, "epic epicgames 堡垒之夜", "game"],
  ["ubisoft", "Ubisoft", "#2367d1", siUbisoft, "ubisoft uplay 育碧", "game"],
  ["ea", "EA", "#e43229", siEa, "ea electronicarts origin", "game"],
  ["riotgames", "Riot Games", "#eb0029", siRiotgames, "riot riotgames 拳头", "game"],
  ["gog", "GOG", "#86328a", siGogdotcom, "gog gog.com", "game"],
  ["battlenet", "Battle.net", "#148ac2", faBattleNet, "battlenet battle.net blizzard 暴雪 战网", "game"],
  ["mihoyo", "HoYoverse", "#2b7ec1", siMihoyo, "mihoyo hoyoverse genshin honkai 米哈游 原神 崩坏 绝区零", "game"],
  ["rockstar", "Rockstar", "#c48400", siRockstargames, "rockstar rockstargames socialclub r星 gta", "game"],
  ["roblox", "Roblox", "#252a31", siRoblox, "roblox 罗布乐思", "game"],
  ["activision", "Activision", "#252a31", siActivision, "activision cod 动视 使命召唤", "game"],
  ["squareenix", "Square Enix", "#d61a21", siSquareenix, "squareenix square enix se 史克威尔 最终幻想 ff14", "game"],
  ["sega", "SEGA", "#0073b5", siSega, "sega 世嘉", "game"],
  ["konami", "Konami", "#b60014", siKonami, "konami 科乐美", "game"],
  ["kick", "Kick", "#1d9a00", siKick, "kick kick.com", "game"],

  // === 主流加密货币交易所 ===
  ["binance", "Binance", "#c28e00", siBinance, "binance binance.com binance.us bnb 币安", "exchange"],
  ["okx", "OKX", "#22272e", siOkx, "okx okex okx.com 欧易", "exchange"],
  ["bybit", "Bybit", "#c48500", customBrandIcons.bybit, "bybit bybit.com", "exchange"],
  ["bitget", "Bitget", "#0097a7", customBrandIcons.bitget, "bitget bitget.com", "exchange"],
  ["coinbase", "Coinbase", "#0052ff", siCoinbase, "coinbase coinbase.com cb", "exchange"],
  ["kraken", "Kraken", "#5741d9", customBrandIcons.kraken, "kraken kraken.com 海妖", "exchange"],
  ["kucoin", "KuCoin", "#009e75", siKucoin, "kucoin kucoin.com 库币", "exchange"],
  ["gate-io", "Gate.io", "#177ddc", customBrandIcons.gateIo, "gate.io gateio gate 芝麻开门 比特儿", "exchange"],
  ["htx", "HTX", "#0d6efd", customBrandIcons.htx, "htx huobi huobi.com htx.com 火币 火必", "exchange"],
  ["mexc", "MEXC", "#1976d2", customBrandIcons.mexc, "mexc mexc.com 抹茶", "exchange"],
  ["crypto-com", "Crypto.com", "#103f68", customBrandIcons.cryptoCom, "crypto.com cryptocom cro", "exchange"],
  ["bitfinex", "Bitfinex", "#14994b", customBrandIcons.bitfinex, "bitfinex bitfinex.com 大B网", "exchange"],
  ["bitstamp", "Bitstamp", "#159c5b", customBrandIcons.bitstamp, "bitstamp bitstamp.net", "exchange"],
  ["gemini", "Gemini", "#008da6", customBrandIcons.gemini, "gemini gemini.com 双子星", "exchange"],
  ["upbit", "Upbit", "#093687", customBrandIcons.upbit, "upbit upbit.com", "exchange"],
  ["bingx", "BingX", "#2354e6", customBrandIcons.bingx, "bingx bingx.com", "exchange"],
  ["deribit", "Deribit", "#00917a", customBrandIcons.deribit, "deribit deribit.com", "exchange"],
  ["bitmart", "BitMart", "#009485", customBrandIcons.bitmart, "bitmart bitmart.com 币市", "exchange"],
  ["hashkey", "HashKey", "#252a31", customBrandIcons.hashkey, "hashkey hashkey.com hashkeyglobal", "exchange"],
  ["osl", "OSL", "#0c7c59", customBrandIcons.osl, "osl osl.com", "exchange"],
  ["hyperliquid", "Hyperliquid", "#0f8a75", customBrandIcons.hyperliquid, "hyperliquid hyperliquid.xyz hype", "exchange"],
  ["backpack", "Backpack", "#d93630", customBrandIcons.backpack, "backpack backpack.exchange", "exchange"],
  ["polymarket", "Polymarket", "#2e5cff", customBrandIcons.polymarket, "polymarket polymarket.com", "exchange"],
  ["wazirx", "WazirX", "#2658d8", siWazirx, "wazirx wazirx.com", "exchange"],

  // === 加密钱包、硬件钱包与链上生态 ===
  ["bitget-wallet", "Bitget Wallet", "#0a6cff", customBrandIcons.bitgetWallet, "bitgetwallet bitget-wallet bitkeep bitget钱包", "wallet"],
  ["okx-wallet", "OKX Wallet", "#252a31", customBrandIcons.okxWallet, "okxwallet okx-wallet okxweb3 okx钱包 欧易钱包", "wallet"],
  ["metamask", "MetaMask", "#d96b16", customBrandIcons.metamask, "metamask 小狐狸", "wallet"],
  ["phantom", "Phantom", "#6c5ce7", customBrandIcons.phantom, "phantom phantomwallet 幽灵钱包", "wallet"],
  ["trust-wallet", "Trust Wallet", "#0b5ed7", customBrandIcons.trustWallet, "trustwallet trust-wallet", "wallet"],
  ["ledger", "Ledger", "#252a31", customBrandIcons.ledger, "ledger ledgerlive", "wallet"],
  ["trezor", "Trezor", "#14532d", siTrezor, "trezor trezorsuite", "wallet"],
  ["safepal", "SafePal", "#4a3aff", customBrandIcons.safepal, "safepal sfp", "wallet"],
  ["onekey", "OneKey", "#009628", customBrandIcons.onekey, "onekey onekey.so", "wallet"],
  ["keystone", "Keystone", "#166bff", siKeystone, "keystone keyst.one", "wallet"],
  ["rabby", "Rabby", "#5e68e6", customBrandIcons.rabby, "rabby rabbywallet", "wallet"],
  ["imtoken", "imToken", "#0e85d6", customBrandIcons.imtoken, "imtoken token.im", "wallet"],
  ["tokenpocket", "TokenPocket", "#2271e6", customBrandIcons.tokenpocket, "tokenpocket tpwallet", "wallet"],
  ["exodus", "Exodus", "#5a45ff", customBrandIcons.exodus, "exodus exodus.com", "wallet"],
  ["walletconnect", "WalletConnect", "#2c82e0", siWalletconnect, "walletconnect reown", "wallet"],
  ["blockchain", "Blockchain.com", "#121d33", siBlockchaindotcom, "blockchain blockchain.com", "wallet"],
  ["bitcoin", "Bitcoin", "#c87a11", faBitcoin, "bitcoin btc 比特币", "wallet"],
  ["ethereum", "Ethereum", "#3c3c3d", siEthereum, "ethereum eth 以太坊", "wallet"],
  ["solana", "Solana", "#7c3aed", siSolana, "solana sol", "wallet"],
  ["tether", "Tether", "#268a73", siTether, "tether usdt 泰达", "wallet"],
  ["opensea", "OpenSea", "#1b74cc", siOpensea, "opensea opensea.io", "wallet"],

  // === 主流券商、看盘、跨境支付与银行 ===
  ["ibkr", "IBKR", "#c81d25", customBrandIcons.ibkr, "ibkr interactivebrokers interactive-brokers 盈透 盈透证券", "finance"],
  ["futu", "富途 / moomoo", "#d95f00", customBrandIcons.futu, "futu futubull futunn moomoo 富途 富途牛牛", "finance"],
  ["tiger-brokers", "老虎证券", "#c48400", customBrandIcons.tigerBrokers, "tigerbrokers tigertrade 老虎 老虎证券", "finance"],
  ["longbridge", "长桥证券", "#1c2b4a", customBrandIcons.longbridge, "longbridge longport 长桥 长桥证券", "finance"],
  ["webull", "Webull", "#1b5ef0", customBrandIcons.webull, "webull 微牛 微牛证券", "finance"],
  ["usmart", "盈立证券", "#d95314", customBrandIcons.usmart, "usmart 盈立 盈立证券", "finance"],
  ["snowball", "雪盈证券", "#1e6de5", customBrandIcons.snowball, "snowball snowballec xueqiu 雪盈 雪盈证券 雪球", "finance"],
  ["schwab", "Charles Schwab", "#007cb8", customBrandIcons.schwab, "schwab charlesschwab 嘉信 嘉信理财", "finance"],
  ["fidelity", "Fidelity", "#2f7d32", customBrandIcons.fidelity, "fidelity 富达 富达投资", "finance"],
  ["vanguard", "Vanguard", "#96151d", customBrandIcons.vanguard, "vanguard 先锋领航 领航", "finance"],
  ["robinhood", "Robinhood", "#2e7d00", siRobinhood, "robinhood 罗宾汉", "finance"],
  ["etoro", "eToro", "#378f10", customBrandIcons.etoro, "etoro e投睿", "finance"],
  ["trading212", "Trading 212", "#0082bf", customBrandIcons.trading212, "trading212 t212", "finance"],
  ["saxo", "Saxo Bank", "#00529b", customBrandIcons.saxo, "saxo saxobank saxomarkets 盛宝 盛宝银行 盛宝金融", "finance"],
  ["degiro", "DEGIRO", "#0089c7", customBrandIcons.degiro, "degiro", "finance"],
  ["ig", "IG", "#c4161c", customBrandIcons.ig, "ig iggroup igmarkets", "finance"],
  ["oanda", "OANDA", "#168039", customBrandIcons.oanda, "oanda 安达", "finance"],
  ["plus500", "Plus500", "#0066cc", customBrandIcons.plus500, "plus500", "finance"],
  ["exness", "Exness", "#b88600", customBrandIcons.exness, "exness", "finance"],
  ["wealthsimple", "Wealthsimple", "#252a31", customBrandIcons.wealthsimple, "wealthsimple", "finance"],
  ["questrade", "Questrade", "#1e873b", customBrandIcons.questrade, "questrade", "finance"],
  ["tradingview", "TradingView", "#1a202c", siTradingview, "tradingview tv", "finance"],
  ["rakuten", "Rakuten", "#bf0000", siRakuten, "rakuten 乐天 乐天证券", "finance"],
  ["sbi", "SBI 证券", "#004b93", customBrandIcons.sbi, "sbi sbisec sbi证券", "finance"],
  ["zerodha", "Zerodha", "#387ed1", siZerodha, "zerodha kite", "finance"],
  ["paypal", "PayPal", "#1473ad", faPaypal, "paypal 贝宝", "finance"],
  ["alipay", "支付宝", "#1677ff", faAlipay, "alipay 支付宝", "finance"],
  ["wise", "Wise", "#1b7a43", siWise, "wise transferwise", "finance"],
  ["revolut", "Revolut", "#191c1f", siRevolut, "revolut", "finance"],
  ["stripe", "Stripe", "#635bff", siStripe, "stripe", "finance"],
  ["payoneer", "Payoneer", "#d94100", siPayoneer, "payoneer 派安盈", "finance"],
  ["airwallex", "Airwallex", "#5828eb", customBrandIcons.airwallex, "airwallex 空中云汇", "finance"],
  ["mercury", "Mercury", "#4a52e0", customBrandIcons.mercury, "mercury mercurybank", "finance"],
  ["brex", "Brex", "#212121", siBrex, "brex", "finance"],
  ["cashapp", "Cash App", "#009936", siCashapp, "cashapp cash.app", "finance"],
  ["venmo", "Venmo", "#0077db", siVenmo, "venmo", "finance"],
  ["skrill", "Skrill", "#811e68", customBrandIcons.skrill, "skrill", "finance"],
  ["square", "Square", "#3e4348", siSquare, "square block", "finance"],
  ["klarna", "Klarna", "#c94d78", siKlarna, "klarna", "finance"],
  ["paddle", "Paddle", "#b88a00", siPaddle, "paddle paddle.com", "finance"],
  ["lemonsqueezy", "Lemon Squeezy", "#b88300", siLemonsqueezy, "lemonsqueezy", "finance"],
  ["hsbc", "HSBC", "#db0011", siHsbc, "hsbc 汇丰 汇丰银行", "finance"],
  ["ocbc", "OCBC", "#d71920", customBrandIcons.ocbc, "ocbc 华侨银行 新加坡华侨", "finance"],
  ["dbs", "DBS", "#d71920", customBrandIcons.dbs, "dbs 星展 星展银行", "finance"],
  ["zabank", "ZA Bank", "#149665", customBrandIcons.zabank, "zabank za 众安银行", "finance"],
  ["chase", "Chase", "#117aca", siChase, "chase jpmorgan 摩根大通 大通银行", "finance"],
  ["bankofamerica", "Bank of America", "#012169", siBankofamerica, "bankofamerica bofa 美国银行", "finance"],
  ["wellsfargo", "Wells Fargo", "#c81d25", siWellsfargo, "wellsfargo 富国银行", "finance"],
  ["barclays", "Barclays", "#008cc7", siBarclays, "barclays 巴克莱", "finance"],
  ["deutschebank", "Deutsche Bank", "#0018a8", siDeutschebank, "deutschebank 德意志银行", "finance"],
  ["monzo", "Monzo", "#14233c", siMonzo, "monzo", "finance"],
  ["n26", "N26", "#2f8c7a", siN26, "n26", "finance"],
  ["starlingbank", "Starling Bank", "#6935d3", siStarlingbank, "starlingbank starling", "finance"],
  ["bunq", "bunq", "#247cb8", siBunq, "bunq", "finance"],
  ["nubank", "Nubank", "#820ad1", siNubank, "nubank nu", "finance"],

  // === AI 工具 ===
  ["openai", "OpenAI", "#19876b", faOpenai, "openai chatgpt gpt", "ai"],
  ["claude", "Claude", "#c96240", siClaude, "claude claude.ai", "ai"],
  ["anthropic", "Anthropic", "#252a31", siAnthropic, "anthropic console.anthropic", "ai"],
  ["deepseek", "DeepSeek", "#3b68e6", siDeepseek, "deepseek 深度求索", "ai"],
  ["googlegemini", "Google Gemini", "#7358a8", siGooglegemini, "googlegemini aistudio", "ai"],
  ["perplexity", "Perplexity", "#178d9e", siPerplexity, "perplexity pplx", "ai"],
  ["cursor", "Cursor", "#252a31", siCursor, "cursor cursor.com", "ai"],
  ["huggingface", "Hugging Face", "#c48a00", siHuggingface, "huggingface hf 抱脸", "ai"],
  ["mistral", "Mistral AI", "#d9460c", siMistralai, "mistral mistralai", "ai"],
  ["xai", "xAI / Grok", "#252a31", customBrandIcons.xai, "xai grok x.ai", "ai"],

  // === 安全、密码管理与邮箱 ===
  ["1password", "1Password", "#145fe4", si1password, "1password onepassword", "security"],
  ["bitwarden", "Bitwarden", "#175ddc", siBitwarden, "bitwarden vaultwarden", "security"],
  ["lastpass", "LastPass", "#c92722", siLastpass, "lastpass", "security"],
  ["dashlane", "Dashlane", "#0e353d", siDashlane, "dashlane", "security"],
  ["keeper", "Keeper", "#b88400", siKeeper, "keeper keepersecurity", "security"],
  ["proton", "Proton", "#6d4aff", siProton, "proton protonpass protonvpn protondrive", "security"],
  ["protonmail", "Proton Mail", "#6d4aff", siProtonmail, "protonmail proton.me", "security"],
  ["tuta", "Tuta", "#850122", siTuta, "tuta tutanota", "security"],
  ["fastmail", "Fastmail", "#1e4fa3", customBrandIcons.fastmail, "fastmail", "security"],
  ["zoho", "Zoho", "#d92022", siZoho, "zoho zohomail", "security"],
  ["okta", "Okta", "#007dc1", siOkta, "okta", "security"],
  ["auth0", "Auth0", "#d9461a", siAuth0, "auth0", "security"],
  ["yubico", "Yubico", "#5e8f00", siYubico, "yubico yubikey", "security"],
  ["icloud", "iCloud", "#227cd6", siIcloud, "icloud", "security"],
  ["yahoo", "Yahoo", "#6001d2", faYahoo, "yahoo 雅虎", "security"],
  ["yandex", "Yandex", "#d13631", faYandex, "yandex", "security"],
  ["nordvpn", "NordVPN", "#3975e6", siNordvpn, "nordvpn nordaccount nordpass", "security"],
  ["expressvpn", "ExpressVPN", "#d13037", siExpressvpn, "expressvpn", "security"],
  ["mullvad", "Mullvad", "#294d73", siMullvad, "mullvad mullvadvpn", "security"],
  ["surfshark", "Surfshark", "#139999", siSurfshark, "surfshark", "security"],

  // === 云服务、VPS、域名、NAS 与开发 ===
  ["github", "GitHub", "#303741", faGithub, "github", "cloud"],
  ["gitlab", "GitLab", "#df5c2e", faGitlab, "gitlab", "cloud"],
  ["bitbucket", "Bitbucket", "#1769c4", faBitbucket, "bitbucket", "cloud"],
  ["cloudflare", "Cloudflare", "#da7e16", faCloudflare, "cloudflare cf", "cloud"],
  ["aws", "AWS", "#c87800", faAws, "aws amazonwebservices", "cloud"],
  ["googlecloud", "Google Cloud", "#2f74e0", siGooglecloud, "googlecloud gcp", "cloud"],
  ["alibabacloud", "阿里云", "#e05c00", siAlibabacloud, "alibabacloud aliyun 阿里云 阿里", "cloud"],
  ["tencentcloud", "腾讯云", "#006eff", customBrandIcons.tencentcloud, "tencentcloud qcloud 腾讯云", "cloud"],
  ["huawei", "华为云", "#d9161f", siHuawei, "huawei huaweicloud 华为 华为云", "cloud"],
  ["oracle", "Oracle Cloud", "#c74634", customBrandIcons.oracle, "oracle oraclecloud oci 甲骨文", "cloud"],
  ["digitalocean", "DigitalOcean", "#0080ff", faDigitalOcean, "digitalocean", "cloud"],
  ["hetzner", "Hetzner", "#d50c2d", siHetzner, "hetzner", "cloud"],
  ["vultr", "Vultr", "#007bfc", siVultr, "vultr", "cloud"],
  ["ovh", "OVHcloud", "#123f6d", siOvh, "ovh ovhcloud", "cloud"],
  ["scaleway", "Scaleway", "#4f0599", siScaleway, "scaleway", "cloud"],
  ["akamai", "Akamai / Linode", "#0084bd", siAkamai, "akamai linode", "cloud"],
  ["vercel", "Vercel", "#22272e", siVercel, "vercel", "cloud"],
  ["netlify", "Netlify", "#009688", siNetlify, "netlify", "cloud"],
  ["supabase", "Supabase", "#229e68", siSupabase, "supabase", "cloud"],
  ["firebase", "Firebase", "#cf3700", siFirebase, "firebase", "cloud"],
  ["fly-io", "Fly.io", "#4a30a8", siFlydotio, "fly.io flyio", "cloud"],
  ["railway", "Railway", "#22272e", siRailway, "railway railway.app", "cloud"],
  ["render", "Render", "#22272e", siRender, "render render.com", "cloud"],
  ["docker", "Docker", "#1687c4", faDocker, "docker dockerhub", "cloud"],
  ["npm", "npm", "#bd3034", faNpm, "npm npmjs", "cloud"],
  ["unity", "Unity", "#444b55", faUnity, "unity", "cloud"],
  ["atlassian", "Atlassian", "#1769c4", faAtlassian, "atlassian jira confluence", "cloud"],
  ["salesforce", "Salesforce", "#1587b5", faSalesforce, "salesforce", "cloud"],
  ["jetbrains", "JetBrains", "#22272e", siJetbrains, "jetbrains", "cloud"],
  ["postman", "Postman", "#e05926", siPostman, "postman", "cloud"],
  ["sentry", "Sentry", "#362d59", siSentry, "sentry sentry.io", "cloud"],
  ["datadog", "Datadog", "#632ca6", siDatadog, "datadog", "cloud"],
  ["grafana", "Grafana", "#d95d00", siGrafana, "grafana", "cloud"],
  ["figma", "Figma", "#b94e40", faFigma, "figma", "cloud"],
  ["wordpress", "WordPress", "#21759b", faWordpress, "wordpress", "cloud"],
  ["namecheap", "Namecheap", "#de3723", siNamecheap, "namecheap", "cloud"],
  ["godaddy", "GoDaddy", "#008f8f", siGodaddy, "godaddy", "cloud"],
  ["porkbun", "Porkbun", "#d65858", siPorkbun, "porkbun", "cloud"],
  ["gandi", "Gandi", "#6640fe", siGandi, "gandi gandi.net", "cloud"],
  ["squarespace", "Squarespace", "#252a31", siSquarespace, "squarespace", "cloud"],
  ["shopify", "Shopify", "#548a38", siShopify, "shopify", "cloud"],
  ["synology", "群晖 Synology", "#4f5660", siSynology, "synology dsm 群晖", "cloud"],
  ["qnap", "威联通 QNAP", "#0c2e82", siQnap, "qnap 威联通", "cloud"],
  ["proxmox", "Proxmox", "#d45300", siProxmox, "proxmox pve", "cloud"],
  ["unraid", "Unraid", "#d94c21", siUnraid, "unraid", "cloud"],
  ["tailscale", "Tailscale", "#252a31", siTailscale, "tailscale", "cloud"],
  ["ubiquiti", "Ubiquiti", "#0559c9", siUbiquiti, "ubiquiti unifi ubnt", "cloud"],
  ["mikrotik", "MikroTik", "#293239", siMikrotik, "mikrotik routeros", "cloud"],
  ["homeassistant", "Home Assistant", "#1293c4", siHomeassistant, "homeassistant hass", "cloud"],
  ["plex", "Plex", "#c48e00", siPlex, "plex", "cloud"],
  ["jellyfin", "Jellyfin", "#0089ba", siJellyfin, "jellyfin", "cloud"],
  ["notion", "Notion", "#252a31", siNotion, "notion", "cloud"],
  ["linear", "Linear", "#5e6ad2", siLinear, "linear linear.app", "cloud"],
  ["obsidian", "Obsidian", "#7c3aed", siObsidian, "obsidian", "cloud"],
  ["dropbox", "Dropbox", "#0061ff", faDropbox, "dropbox", "cloud"],
  ["googledrive", "Google Drive", "#148e63", faGoogleDrive, "googledrive 谷歌云盘", "cloud"],

  // === 常用平台、社交、办公与硬件 ===
  ["google", "Google", "#4285f4", faGoogle, "google gmail 谷歌", "social"],
  ["microsoft", "Microsoft", "#0878d4", faMicrosoft, "microsoft outlook office azure 微软", "social"],
  ["apple", "Apple", "#43484f", faApple, "apple appleid 苹果", "social"],
  ["amazon", "Amazon", "#b96b00", faAmazon, "amazon 亚马逊", "social"],
  ["discord", "Discord", "#5865f2", faDiscord, "discord", "social"],
  ["telegram", "Telegram", "#2487ba", faTelegram, "telegram 电报", "social"],
  ["twitter", "X / Twitter", "#252a31", faXTwitter, "twitter x 推特", "social"],
  ["facebook", "Facebook", "#1877f2", faFacebook, "facebook 脸书", "social"],
  ["meta", "Meta", "#0064e0", faMeta, "meta", "social"],
  ["instagram", "Instagram", "#c13584", faInstagram, "instagram", "social"],
  ["threads", "Threads", "#252a31", siThreads, "threads", "social"],
  ["bluesky", "Bluesky", "#1185fe", siBluesky, "bluesky bsky", "social"],
  ["reddit", "Reddit", "#e74c13", faReddit, "reddit", "social"],
  ["linkedin", "LinkedIn", "#0a66c2", faLinkedin, "linkedin 领英", "social"],
  ["slack", "Slack", "#61366a", faSlack, "slack", "social"],
  ["zoom", "Zoom", "#0b5cff", siZoom, "zoom", "social"],
  ["whatsapp", "WhatsApp", "#1a9e4b", siWhatsapp, "whatsapp", "social"],
  ["signal", "Signal", "#3b45fd", siSignal, "signal", "social"],
  ["line", "LINE", "#00a600", siLine, "line", "social"],
  ["kakaotalk", "KakaoTalk", "#b88900", siKakaotalk, "kakaotalk kakao", "social"],
  ["snapchat", "Snapchat", "#c49a00", siSnapchat, "snapchat", "social"],
  ["youtube", "YouTube", "#db3232", faYoutube, "youtube 油管", "social"],
  ["twitch", "Twitch", "#9146ff", faTwitch, "twitch", "social"],
  ["spotify", "Spotify", "#168e40", faSpotify, "spotify", "social"],
  ["netflix", "Netflix", "#d90913", siNetflix, "netflix 奈飞 网飞", "social"],
  ["patreon", "Patreon", "#252a31", siPatreon, "patreon", "social"],
  ["substack", "Substack", "#e05912", siSubstack, "substack", "social"],
  ["tiktok", "TikTok", "#303741", faTiktok, "tiktok 抖音", "social"],
  ["vimeo", "Vimeo", "#2488b3", faVimeo, "vimeo", "social"],
  ["mastodon", "Mastodon", "#6364ff", faMastodon, "mastodon 长毛象", "social"],
  ["pinterest", "Pinterest", "#c8232c", faPinterest, "pinterest", "social"],
  ["chrome", "Chrome", "#3874bd", faChrome, "chrome", "social"],
  ["brave", "Brave", "#d9461a", faBrave, "brave", "social"],
  ["android", "Android", "#328d58", faAndroid, "android 安卓", "social"],
  ["wechat", "微信", "#199c4e", faWeixin, "wechat weixin 微信", "social"],
  ["qq", "QQ", "#278bc5", faQq, "qq 腾讯", "social"],
  ["feishu", "飞书 / Lark", "#009e88", customBrandIcons.feishu, "feishu lark 飞书", "social"],
  ["dingtalk", "钉钉", "#007fff", customBrandIcons.dingtalk, "dingtalk 钉钉", "social"],
  ["bilibili", "哔哩哔哩", "#0092c2", siBilibili, "bilibili b站 哔哩哔哩", "social"],
  ["xiaohongshu", "小红书", "#e6203b", siXiaohongshu, "xiaohongshu rednote 小红书", "social"],
  ["zhihu", "知乎", "#0077e6", siZhihu, "zhihu 知乎", "social"],
  ["taobao", "淘宝", "#d94518", siTaobao, "taobao tmall 淘宝 天猫", "social"],
  ["meituan", "美团", "#c48f00", siMeituan, "meituan 美团", "social"],
  ["baidu", "百度", "#2932e1", siBaidu, "baidu 百度", "social"],
  ["bytedance", "字节跳动", "#307ae6", siBytedance, "bytedance 字节 字节跳动", "social"],
  ["ebay", "eBay", "#d92c32", siEbay, "ebay", "social"],
  ["etsy", "Etsy", "#d95716", siEtsy, "etsy", "social"],
  ["aliexpress", "AliExpress", "#e03636", siAliexpress, "aliexpress 速卖通", "social"],
  ["airbnb", "Airbnb", "#e0484d", siAirbnb, "airbnb 爱彼迎", "social"],
  ["uber", "Uber", "#303741", faUber, "uber 优步", "social"],
  ["tesla", "Tesla", "#cc0000", siTesla, "tesla 特斯拉", "social"],
  ["nvidia", "NVIDIA", "#5a9600", siNvidia, "nvidia 英伟达", "social"],
  ["samsung", "Samsung", "#1428a0", siSamsung, "samsung 三星", "social"],
  ["xiaomi", "小米", "#e65c00", siXiaomi, "xiaomi 小米 米家", "social"],
  ["dji", "DJI 大疆", "#252a31", siDji, "dji 大疆", "social"],
];

export const brands: Brand[] = brandRows.map(([id, name, color, icon, aliases, category]) => ({
  id,
  name,
  color,
  icon,
  aliases,
  category,
}));

const brandCategories: readonly {
  id: BrandCategory | "all";
  label: () => string;
}[] = [
  { id: "all", label: () => translate("全部") },
  { id: "exchange", label: () => translate("交易所") },
  { id: "wallet", label: () => translate("钱包") },
  { id: "finance", label: () => translate("券商金融") },
  { id: "game", label: () => translate("游戏") },
  { id: "cloud", label: () => translate("云与开发") },
  { id: "ai", label: () => translate("AI 工具") },
  { id: "security", label: () => translate("安全邮箱") },
  { id: "social", label: () => translate("社交常用") },
];

const normalized = (value: string) =>
  value.toLowerCase().replace(/[\s._:-]/g, "");
const hasCjk = (value: string) => /[\u4e00-\u9fff]/.test(value);
// 容易在普通英文单词中误匹配的短词或常见英文词，仅参与精确匹配或词边界匹配。
const exactOnlyTerms = new Set([
  "ea",
  "ig",
  "qq",
  "x",
  "ns",
  "ps",
  "cb",
  "cf",
  "tv",
  "se",
  "hf",
  "nu",
  "za",
  "sol",
  "eth",
  "btc",
  "bnb",
  "cro",
  "sfp",
  "cod",
  "gta",
  "pve",
  "dsm",
  "oci",
  "gcp",
  "gpt",
  "line",
  "gate",
  "kick",
  "meta",
  "kite",
  "block",
  "square",
  "signal",
  "render",
  "linear",
  "cursor",
  "circle",
  "brave",
  "stripe",
  "paddle",
  "chase",
  "wise",
  "hype",
  "osl",
  "sbi",
  "dbs",
  "ovh",
  "dji",
]);

const brandIndex = brands.map((brand) => {
  const normalizedAliases = Array.from(
    new Set([normalized(brand.id), ...brand.aliases.split(" ").map(normalized)].filter(Boolean)),
  );
  return { brand, normalizedAliases };
});
const brandById = new Map(brands.map((brand) => [brand.id, brand]));
// 构造按长度降序排列的子串匹配索引，确保 Bitget Wallet / OKX Wallet / Google Cloud 等长品牌优先命中。
const substringMatches = brandIndex
  .flatMap(({ brand, normalizedAliases }) =>
    normalizedAliases
      .filter((term) => {
        if (exactOnlyTerms.has(term)) return false;
        return hasCjk(term) ? term.length >= 2 : term.length >= 4;
      })
      .map((term) => ({ term, brand })),
  )
  .sort((a, b) => b.term.length - a.term.length);
// 词元级匹配索引：覆盖由分隔符隔开的短品牌名（如 "LINE · user"、"IG Trading"、"Gate.io"）。
const tokenMatchByTerm = new Map<string, Brand>();
for (const { brand, normalizedAliases } of brandIndex) {
  for (const term of normalizedAliases) {
    if (term.length >= 2 && !tokenMatchByTerm.has(term)) {
      tokenMatchByTerm.set(term, brand);
    }
  }
}
const automaticBrandCache = new Map<string, Brand | undefined>();

function splitTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s/\\|·•,()[\]@:_-]+/)
    .map((part) => part.replace(/\./g, ""))
    .filter(Boolean);
}

export function automaticBrand(
  token: Pick<TokenView, "kind" | "issuer" | "name">,
) {
  if (token.kind === "steam") return brands[0];
  const key = `${token.kind}\0${token.issuer}\0${token.name}`;
  if (automaticBrandCache.has(key)) return automaticBrandCache.get(key);
  const issuer = normalized(token.issuer);
  const name = normalized(token.name);

  let matched: Brand | undefined;
  if (issuer) {
    matched = brandIndex.find(({ normalizedAliases }) =>
      normalizedAliases.includes(issuer),
    )?.brand;
  }
  if (!matched && name) {
    matched = brandIndex.find(({ normalizedAliases }) =>
      normalizedAliases.includes(name),
    )?.brand;
  }
  if (!matched && issuer) {
    matched = substringMatches.find(({ term }) => issuer.includes(term))?.brand;
  }
  if (!matched && name) {
    matched = substringMatches.find(({ term }) => name.includes(term))?.brand;
  }
  if (!matched) {
    for (const part of [...splitTokens(token.issuer), ...splitTokens(token.name)]) {
      const candidate = tokenMatchByTerm.get(part);
      if (candidate) {
        matched = candidate;
        break;
      }
    }
  }

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

function isFaIcon(asset: BrandIconAsset): asset is typeof faSteam {
  return "icon" in asset;
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
  if (brand) {
    const asset = brand.icon;
    const viewBox = isFaIcon(asset)
      ? `0 0 ${asset.icon[0]} ${asset.icon[1]}`
      : "0 0 24 24";
    const paths: readonly string[] = isFaIcon(asset)
      ? Array.isArray(asset.icon[4])
        ? asset.icon[4]
        : [asset.icon[4]]
      : Array.isArray(asset.path)
        ? asset.path
        : [asset.path];
    const fillRule =
      !isFaIcon(asset) && "fillRule" in asset ? asset.fillRule : undefined;
    return (
      <span
        className="token-avatar brand-avatar"
        style={{ color: brand.color }}
        aria-label={brand.name}
      >
        <svg viewBox={viewBox} aria-hidden="true">
          {paths.map((path, i) => (
            <path key={i} d={path} fill="currentColor" fillRule={fillRule} />
          ))}
        </svg>
      </span>
    );
  }
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
  const [category, setCategory] = useState<BrandCategory | "all">("all");
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
  const compactSearch = normalized(search);
  const filteredSaved = useMemo(
    () =>
      savedIcons.filter(
        (item) => !normalizedSearch || item.label.toLowerCase().includes(normalizedSearch),
      ),
    [savedIcons, normalizedSearch],
  );
  const filteredBrands = useMemo(
    () =>
      brands.filter((brand) => {
        if (normalizedSearch) {
          const hay = `${brand.name} ${brand.aliases}`.toLowerCase();
          return (
            hay.includes(normalizedSearch) ||
            (compactSearch.length > 0 && normalized(hay).includes(compactSearch))
          );
        }
        return category === "all" || brand.category === category;
      }),
    [normalizedSearch, compactSearch, category],
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
      {!normalizedSearch && (
        <div
          className="icon-category-tabs"
          role="group"
          aria-label={translate("图标分类")}
        >
          {brandCategories.map((item) => (
            <button
              key={item.id}
              type="button"
              className={category === item.id ? "selected" : ""}
              aria-pressed={category === item.id}
              onClick={() => setCategory(item.id)}
            >
              {item.label()}
            </button>
          ))}
        </div>
      )}
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
      {filteredBrands.length > 0 ? (
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
      ) : (
        <p className="icon-empty-hint">{translate("未找到匹配的图标")}</p>
      )}
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
