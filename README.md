# 同声传译网页版 · 英译中

浏览器收音,实时出英文识别 + 中文译文。手机、电脑打开网页就能用,密钥在网页里填。

- **阿里云百炼** —— Gummy 识别+翻译一步到位(约 **0.54 元/小时**,仅北京地域);
  其它地域可用「纯识别 + 大模型翻译」
- **火山引擎** —— 大模型流式识别 + 方舟豆包翻译
- **演示模式** —— 不填密钥、不联外网,先看效果

接入地址和模型都在网页里填,不写死 —— 因为百炼的地址会随**地域**和**业务空间**变。

```
.
├── api/asr.js         Vercel 函数入口(部署后即 wss://<域名>/api/asr)
├── lib/relay.js       中转核心,上面两个入口共用同一份
├── server.js          本地 / 自建服务器入口(发网页 + 中转)
├── public/index.html  前端(单文件,无构建)
├── public/manifest.webmanifest   PWA 清单(装到手机主屏用)
├── public/sw.js       Service Worker(秒开 / 离线能打开界面)
├── public/icon-*.png  图标(改配色后跑 tools/make-icons.py 重新生成)
├── vercel.json
├── start.bat          Windows:双击即可
├── start.sh           macOS / Linux
└── .env.example
```

三种跑法,选一种:

| | 适合 | 手机能用吗 |
|---|---|---|
| **Vercel 部署** | 想要一个随时随地能打开的网址 | ✅ 自带 HTTPS,可装到主屏 |
| **本地跑** | 只在自己电脑上用 | ❌ 见第五节 |
| **自建服务器** | 长时间、多人用 | ✅ 配域名+证书 |

---

## 一、为什么必须有中转服务

浏览器不能直连这两家,**不是安全建议,是协议层面走不通**:

| | 鉴权方式 | 浏览器能做到吗 |
|---|---|---|
| 阿里云百炼 | `Authorization: Bearer sk-xxx`(HTTP Header) | ❌ |
| 火山引擎 | `X-Api-App-Key` / `X-Api-Access-Key`(HTTP Header) | ❌ |

浏览器的 `new WebSocket(url)` **没有任何参数可以设置请求头**。所以中间必须有一层自己的服务。
顺带的好处:API Key 不会出现在前端 JS 里。

```
手机/电脑浏览器 ──16kHz PCM over WSS──> 你的中转 ──> 阿里云 / 火山引擎
```

---

## 二、部署到 Vercel

Vercel 现在**原生支持 WebSocket**(需要 Fluid compute,2025-04-23 之后创建的项目默认开启),
所以整个项目可以直接跑在上面,不需要另外买服务器。

### 步骤

1. 把这个仓库推到你自己的 GitHub
2. Vercel → **Add New → Project** → 选这个仓库 → **Deploy**
3. 不用改任何构建设置。Vercel 会自动:
   - 把 `public/` 当静态站点发出去
   - 把 `api/asr.js` 编译成一个函数,挂在 `/api/asr`
4. 部署完打开 `https://你的项目.vercel.app`,右上角齿轮填密钥 → **测试连接** → 开始

前端会自动用同源地址连中转(`wss://你的项目.vercel.app/api/asr`),**不用手填中转地址**。

### ⚠ 一定要改函数区域,否则音频绕地球半圈

Vercel 函数**默认跑在美东**(`iad1`)。国内用户 + 阿里云新加坡的话,音频路径会变成
「上海 → 美东 → 新加坡」,白白多几百毫秒,同传直接没法用。

`vercel.json` 里已经设成香港:

```json
{ "regions": ["hkg1"] }
```

香港夹在国内和新加坡/北京中间,是 Vercel 现有区域里最合适的(它没有中国大陆节点)。
Hobby 免费版**支持设置单个区域**,不用升级。也可以在 Settings → Functions → Function Regions 里改。

改完要重新部署才生效。

### ⚠ 免费版每 5 分钟会断一次连接

Vercel 上一条 WebSocket 的寿命 = 函数最长执行时长:

| 套餐 | 单条连接最长 |
|---|---|
| Hobby(免费) | 300 秒(5 分钟) |
| Pro | 800 秒,单函数可配到 1800 秒 |

**前端已经做了自动重连**,断开后立刻重连:已有字幕不会丢,麦克风不中断,
只损失重连那一瞬间(几百毫秒)的音频,顶部会短暂显示「重连中…」。所以免费版也能连续用。

如果你是 Pro,想把重连间隔拉长到 800 秒,改 `vercel.json`:

```json
{ "functions": { "api/asr.js": { "maxDuration": 800 } } }
```

### ⚠ 关于费用

同传是**持续占用函数运行时间**的:开一小时,就是一小时的函数执行时长 + 数据传输。
这和普通网站那种「一次请求几百毫秒」的用量模型完全不同,Hobby 的免费额度可能撑不了太久。
自己留意 Vercel 的 Usage 页面。这部分是 Vercel 的钱,和阿里云/火山的识别费用是两笔。

### 如果连不上 /api/asr

- 确认项目开了 **Fluid compute**(Settings → Functions)
- 老项目可能需要在项目设置里启用 WebSocket 支持
- 打开 `https://你的项目.vercel.app/api/asr`,正常会返回一段 JSON 说明;返回 404 说明函数没部署上

### 密钥要不要放 Vercel 环境变量?

两种都行:

- **不放**(推荐先这样):在网页里填,只存在你自己浏览器的 localStorage
- **放**:Vercel → Settings → Environment Variables,填 `ALIYUN_API_KEY` 等(见 `.env.example`),
  网页里留空即可。注意这样一来,**任何能打开这个网址的人都能用你的额度** —— Vercel 项目默认是公开的。

---

## 三、在自己电脑上跑

### ⚠ 先说一个最容易踩的坑

**不要双击 `public\index.html` 直接打开。** 那是 `file://` 协议,没有中转服务,浏览器多半也不给用麦克风。

正确做法是把服务跑起来,然后用浏览器访问 `http://localhost:8787`。

### Windows

双击 **`start.bat`**。它会自己检查 Node、装依赖、启动服务、打开浏览器。停止服务直接关掉黑窗口。

### macOS / Linux

```bash
chmod +x start.sh && ./start.sh
```

### 手动

需要 Node 18 以上。在**有 server.js 的那一层**目录里:

```bash
npm install
node server.js
```

浏览器打开 **http://localhost:8787** → 齿轮 → 填密钥 → **测试连接** → 开始。

> `localhost` 是浏览器认可的安全上下文,所以 http 也能用麦克风。
> 依赖装不上多半是网络问题:`npm config set registry https://registry.npmmirror.com`

---

## 四、部署到自己的服务器

适合长时间、多人使用,没有 Vercel 那个 5 分钟断连的问题。

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs caddy
git clone <你的仓库> /opt/si && cd /opt/si && npm install

sudo tee /etc/systemd/system/si.service >/dev/null <<'EOF'
[Unit]
Description=SI relay
After=network.target
[Service]
WorkingDirectory=/opt/si
ExecStart=/usr/bin/node server.js
Environment=PORT=8787
Restart=always
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now si

# Caddy 自动申请并续期证书,WebSocket 无需额外配置
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
si.你的域名.com {
    reverse_proxy 127.0.0.1:8787
}
EOF
sudo systemctl reload caddy
```

阿里云轻量应用服务器最低配(约 24 元/月)就够。国内服务器域名需要备案。

---

## 五、在手机上用

**手机上什么都不用装、不用下载。** 部署到 Vercel 之后,直接用浏览器打开那个网址就能用。
这个仓库里的文件只是给你推到 GitHub 用的,和手机没关系。

### iPhone

1. 用 **Safari** 打开 `https://你的项目.vercel.app`
2. 首次打开会自动弹设置,填好密钥 → 保存 → 测试连接
3. 想要像 App 一样全屏:点屏幕**底部中间的分享按钮**(方框向上箭头)→ 往下滑找到
   **「添加到主屏幕」** → 右上角**添加**。之后从桌面图标打开就没有地址栏了。

> 必须是 **Safari**。微信、QQ 内置浏览器打开没有「添加到主屏幕」这个选项,
> 而且它们对麦克风的支持也不完整。

### 安卓

Chrome 打开同一个网址,设置面板里会出现「立即安装」按钮,点一下就装到桌面了。

### 手机上的两个限制,说在前面

- **锁屏或切到别的 App 就会停。** iOS 和安卓都不允许后台网页占用麦克风,这是系统层面的限制,
  网页做不了任何事。页面已经申请了屏幕常亮(Wake Lock),尽量不让它自己息屏;
  回到前台如果顶部提示「收音中断」,点一下暂停再继续就恢复。
  要真正后台运行,只能做原生 App。
- **没有悬浮窗。** 画中画是桌面 Chrome/Edge 独有的,手机上这个按钮会自动隐藏。

### 局域网直连电脑(不部署也想用)

麦克风只在 **https** 或 **localhost** 下可用。手机通过 `http://192.168.x.x:8787` 打开会被浏览器直接拒绝录音。

- **部署到 Vercel 或自己的服务器** —— 自带 HTTPS,最省事
- **同一 WiFi,不要证书**:安卓 Chrome 打开 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
  填入电脑的局域网地址(如 `http://192.168.1.7:8787`),改成 Enabled,重启浏览器。
  只影响你这台手机。**iOS Safari 没有这个开关。**
- **自签证书**:
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout key.pem -out cert.pem -subj "/CN=192.168.1.7" \
    -addext "subjectAltName=IP:192.168.1.7"
  TLS_CERT=cert.pem TLS_KEY=key.pem node server.js
  ```
  安卓 Chrome 在警告页点「高级 → 继续访问」即可;iOS 需要把证书装进「设置 → 通用 → VPN 与设备管理」并在「关于本机 → 证书信任设置」里手动信任。

---

## 六、密钥从哪来

### 阿里云百炼 —— 先搞清楚地域

**地域、API Key、模型列表三者绑定,不能跨地域混用。** 新加坡的 Key 打北京的域名,一定 401/403。

| 地域 | WebSocket 接入地址 | 有 Gummy 吗 |
|---|---|---|
| 北京 cn-beijing | `wss://dashscope.aliyuncs.com/api-ws/v1/inference` | ✅ 有 |
| 新加坡 ap-southeast-1 | `wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference` | ❌ 没有 |
| 业务空间专属域名 | `wss://{ws-xxxx}.{地域}.maas.aliyuncs.com/api-ws/v1/inference` | 看地域 |

**Gummy(识别+翻译一步到位)只在北京地域提供。** 其它地域只有纯识别模型,翻译要另外接大模型。

| 你的情况 | 识别模型 | 翻译方式 |
|---|---|---|
| 北京地域(推荐,国内延迟也更低) | `gummy-realtime-v1` | 模型自带翻译 |
| 新加坡等其它地域 | `qwen-audio-3.0-asr-flash-streaming` | 识别后用大模型翻译(`qwen-flash`) |

拿 Key:[百炼控制台](https://bailian.console.aliyun.com/) → 右上角**先切到目标地域** → API-KEY → 创建。
创建完弹窗里那个 **API Host** 直接复制,粘到设置的「接入地址」里,协议和路径会自动补全。

Gummy 计费 **0.00015 元/秒**(约 0.54 元/小时),限流 10 RPS。

### 火山引擎

| 填什么 | 去哪拿 |
|---|---|
| App ID / Access Token | [语音技术控制台](https://console.volcengine.com/speech/app) → 创建应用 → 开通「大模型流式语音识别」 |
| Resource ID | 同上,按开通的计费方式选 `volc.bigasr.sauc.duration`(时长版)或 `.concurrent`(并发版) |
| 方舟 API Key + 模型 | [方舟控制台](https://console.volcengine.com/ark) → API Key,模型填 ID 或推理接入点 `ep-xxxx` |

翻译建议用 flash 类小模型,延迟最低。

---

## 七、界面说明

| | |
|---|---|
| 上半屏 | 英文识别结果。**灰色 = 中间结果**,还会被改写;白色 = 已定稿 |
| 下半屏 | 中文译文,同样的灰白规则 |
| 开启浮窗 | 桌面 Chrome/Edge 的画中画小窗,只显示译文,可浮在其它窗口上面 |
| 开始 / 暂停 | 也可以按空格键 |
| 双语 | 关掉上半屏,译文占满全屏 |
| 清空 | 清掉当前所有字幕,**不中断收音**。要点两下确认,免得一整场记录被误触点没 |
| 完成 | 停止并导出本次记录(复制 / 下载 txt) |
| 齿轮 | 设置。密钥只存在本机 localStorage |

设置面板里的 **测试连接** 会真的走一次握手 + run-task,把上游的真实响应给你看
—— 是 401 鉴权失败、是模型不存在、还是连中转都没起来,一眼就知道。

**断句静音阈值**决定说话人停顿多久算一句结束。调小出字更碎更快,调大更完整但延迟高,默认 800ms。

---

## 八、出问题时看这里

**先点「测试连接」**,它会直接告诉你卡在哪一环。

| 现象 | 原因 |
|---|---|
| 提示「你是直接打开的网页文件」 | 双击 index.html 打开的。改成双击 start.bat,再访问 http://localhost:8787 |
| 点开始提示不能用麦克风 | 不是 https 也不是 localhost,见第五节 |
| 顶部一直显示「重连中…」 | Vercel 上正常(5 分钟一次);一直重连不上就是中转挂了 |
| 「连不上中转服务」 | 本地:`node server.js` 没跑。Vercel:检查 Fluid compute 有没有开 |
| 阿里云握手失败 **HTTP 401 / 403** | **Key 和接入地址的地域对不上**,或 Key 无效。见第六节地域表 |
| 阿里云报模型不存在 | 该地域没有这个模型 —— Gummy 只在北京有 |
| 只出英文不出中文 | 翻译方式选了「大模型翻译」但没填模型/地址;或火山那条没填方舟 Key |
| 火山握手失败 401 / 403 | App ID、Access Token、Resource ID 三个里有一个不对 |
| 火山报参数错误 | 「识别语种」把 `en-US` 换成 `en` 再试 |
| 中文一直跳变闪烁 | 把断句阈值调大一些 |
| 手机锁屏后就断了 | iOS/安卓会在息屏后掐掉麦克风,这是系统限制。页面已申请屏幕常亮(Wake Lock),回到前台若顶部提示「收音中断」,点一下暂停再继续即可 |

### 关于最小化和切换窗口

**桌面端把窗口最小化、切到别的标签页或别的程序,收音和翻译都照常进行。** 音频的重采样和分帧全部放在
AudioWorklet 里 —— 它跑在音频渲染线程上,实时优先级,不受浏览器对后台标签页的定时器降频影响。
主线程只负责把做好的帧丢进 WebSocket,不参与任何计时。实测切到后台后仍是满速 25 帧/秒,一帧不少。

想边看别的窗口边看字幕,用底部的**开启浮窗**(桌面 Chrome/Edge),译文会浮在所有窗口最上面。

本地跑时,终端会打印每个连接用的接入地址、模型、音频帧数和上游返回的原始错误。
Vercel 上看 Deployments → 对应部署 → Logs。

---

## 九、想改的地方

- **换服务商**:在 `lib/relay.js` 里照 `startAliyun` / `startVolc` 加一个函数,返回 `{audio(buf), stop()}`,
  登记到 `START` 表即可。前端只认 `partial` / `final` / `ready` / `error` 四种消息,不用动,
  「测试连接」也会自动支持。
- **换音频来源**(翻译电脑上播放的视频而不是麦克风):把 `public/index.html` 里 `Mic.start()` 的
  `getUserMedia` 换成 `getDisplayMedia({video:true, audio:true})`,其余链路不变。
- **术语准确度**:阿里云那条填热词表 ID;火山那条在 `LLMTranslator` 的 system prompt 里加术语对照表。

## 技术细节

- 前端把麦克风的 Float32 音频重采样到 **16kHz / 16bit / 单声道 PCM**,每 40ms 一帧(1280 字节)——
  这是两家 API 都要的格式。重采样器做过 60 秒零漂移验证。
- 中间结果不逐词翻译:那样下半屏会疯狂闪烁。Gummy 由模型内部处理;大模型翻译那条做了节流 + 缓存。
- 火山用的是二进制协议:4 字节头 + 4 字节长度 + payload,细节见 `lib/relay.js` 里的注释。
