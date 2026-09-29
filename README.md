# dsh-image-openai

**用任意 OpenAI 兼容接口生成图片，并且自己决定要不要把这个能力交给模型。** 一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件。

---

## 它做什么

**两种用法，由参数决定：**

| 你给的参数 | 走哪条接口 | 干什么 |
|---|---|---|
| 只有 `prompt` | `POST <baseURL>/images/generations` | 文字生图 |
| 多给一个 `image`（本地图片路径） | `POST <baseURL>/images/edits`（multipart 上传） | **图生图 / 编辑已有图片** |

它把界面分成**两处**，各放各的东西：

**1. 输入框自己的工具行 —— 只有一个开关**

就是那一行 `+`、`完全权限`、`模型`、发送按钮所在的行；开关在**左边一组、紧挨着「完全权限」的右边**：

```
[ + ]  [ 完全权限 ▾ ]  [ ●—— 生成图片 ]        [ 模型 ▾ ]  [ ↑ ]
```

| 控件 | 行为 |
|---|---|
| **生成图片**（开关） | 决定 `generate_image` 工具是否被**组合进 agent 预设** |

按钮上**只写「生成图片」四个字**：这一行还要放权限和模型选择，写全「图像工具：已注入到预设」太长。状态走另外三处——滑块的颜色与位置、`aria-checked`、以及鼠标悬停的提示（`生成图片：已注入到预设。开关决定 generate_image 是否被组合进预设；模型在「设置 → 插件」里配置。`）。

> **为什么不在输入框下面那一行？** 那里是**环境信息条**（tok/s、缓存命中、上下文占用），是只读状态；而「模型能不能用这个工具」是**输入区的一个控制**，该和权限、模型放在一起。`conversation.input.left` 这个插槽的契约写的正是「composer 工具行左侧的紧凑控件」，所以放这里。

**2. 侧边栏 → 设置 → 插件 → 本插件那一行 —— 设置页面**

打开本插件的那一行，右上会出现一个**配置**按钮，点开就是设置页面。里面可以：

- 从**你已经配置好的 DSH 模型提供商**里挑一个（不用重打地址和密钥）；
- 选一个图像模型、填尺寸/质量/输出目录/提示词前缀/额外参数；
- 写一句提示词，点**生成图片**当场试一张。

> **为什么设置不放输入框下面？** 因为那是「这一行插件的配置」，DSH 的插件页面已经为它准备了位置：`plugins.row.config` 这个插槽的契约里写明「bundle 的配置属于这里，而不是 `plugins.item`」，插件管理器会给对应的行加一个**配置**入口。设置只有**一个家**，就不会出现两处数值不一致。

## 图生图（传入 `image` 时）

工具多了一个参数 `image`：**给了它就编辑那张图，不给就照旧文字生图**。同一个模型、同一份设置，只是换了接口。

```
generate_image({ prompt: "把它改成夜晚的雪景", image: "/Users/you/Pictures/room.png" })
```

- **路径规则和 `outputDir` 一样**：绝对路径直接用；相对路径相对**当前会话的工作目录**；开头 `~` 展开成家目录。所以模型可以写它读得到的那个路径。
- **走 multipart 上传，不是 URL**：编辑接口收的是文件本身。`content-type` 由 `fetch` 自己写 —— 手写 `multipart/form-data` 会漏掉 boundary，网关解析不了表单（自检里有一条专门盯着这个）。
- **类型按字节判定，不看扩展名**：前几个字节决定是 PNG / JPEG / WebP / GIF，上传文件名也跟着改成正确后缀。一个其实是 JPEG 的 `photo.png` 会被标成 `photo.jpg`；不认识的类型直接报错，不会白发一次请求。
- **上限 50MB**：上传必然要把文件读进内存，而网关自己的上限更低（OpenAI 的编辑接口是 25MB）。路径不存在、指向目录、空的 `image`（模型偶尔会把字段填成空字符串）分别处理：前两个报错，**空字符串当作「没传」，走文字生图**。
- **`style` 不发**：它属于文字生图（DALL·E 3），多送一个不支持的字段最容易被网关整单拒掉。需要就用「额外参数（JSON）」自己加。
- **不做 mask / 局部重绘**，也不支持一次传多张图。要的话再说。
- 网关没有这条接口时，报错直接点名：`image provider returned 404 (this provider does not implement /images/edits, so it cannot edit an input image): …`。

### 怎么知道你的网关支不支持

看状态码就够了，而且**不用密钥**：未认证地 POST 一下，路由存在就是 401，不存在才是 404。拿 `/v1/models` 当对照：

```bash
B=https://your-gateway/v1
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/models               # 对照
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/images/generations   # 对照
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/images/edits         # 要问的
```

`401` = 路由在（只是缺密钥）；`404 page not found` = 没有这条路由。实测某网关：`models` 401、`generations` 401、**`edits` 401**、`variations` 404 —— 说明它先路由后鉴权，这个对比才可靠。

## 「注入到预设」到底是什么

这是本插件唯一需要解释清楚的设计。

开关**不是**插件内部的标志位，也**不是在调用时才把工具藏起来**——它是**组合层**的开关。所谓「注入到预设」，就是 profile 的补丁里**工具那一行**是启用还是停用。所以开关做的事，和你打开侧边栏**插件**页面、在那一行上拨开关是**同一件事**：

- 开关读的是 `remote.pluginManager.listPlugins()`；
- 写的是 `remote.pluginManager.setPluginEnabled(<工具行的 entryId>, …)`；
- 这个 Remote 正是官方插件管理页调用的那一个。

因此开关和插件管理页**永远不可能显示得不一样**，它们读写的本来就是同一份状态。效果也是实在的：工具行被真的挂进（或移出）组合，模型看到的工具表跟着变。

### 两行，一个包

| 行 id | 模块（specifier） | 内容 | 会被开关关掉吗 |
|---|---|---|---|
| **`image-openai`** | `dsh-image-openai` | 输入框工具行里的开关、插件页里的设置页面、HTTP 路由 | **不会**，永远是组合的一层 |
| **`image-openai-tool`** | **`dsh-image-openai/tool`** | 只有 `generate_image` 这一个工具 | 会 |

两行是 `dsh-image-openai` 的补丁一起登记的，第二行指向本包的 **`./tool` 子路径**。它**不声明 `dsh.bundle`**，所以插件页的「已安装」里**始终只有一个条目**。

**为什么第二行要用子路径？** 插件页用**那一行所指 specifier 自己的**标题和描述来渲染（宿主端 `packages.metaOf(row.name, base)`），而这个查找是**按 specifier 解析**的：

```js
const englishPath = optionalResourcePath(`${specifier}/locale/en.json`, parentURL);
const manifestPath = optionalResourcePath(`${specifier}/package.json`, parentURL);
```

也就是说它读的是 `<specifier>/locale/<语言>.json`，**不是**裸包名的 locale。所以：

- 两行写**同一个 specifier** → 两行标题、描述完全一样，看上去像重复渲染了两遍（这个问题真实发生过，被指出来了）；
- 第二行写**子路径** → 它有自己的 `tool/locale/*.json` 和 `tool/package.json`，于是每行各自说明自己是谁：一个是「图像生成（OpenAI 兼容）」，一个是「生成图片工具（可注入）」。

**两个 `exports` 条目是承重的，不是装饰**，实测缺一个就会静默退化：

| exports 条目 | 少了会怎样 |
|---|---|
| `"./tool/locale/*.json"` | 语言文件解析不到，标题回退成包名 |
| `"./tool/package.json"` | 图标读不到，那一行没有图标 |

（每个语言文件都会被 `dictionariesOf` 用完整 specifier 重新解析一遍，所以只放行 `./locale/*.json` 是不够的。）

那**为什么它不出现在「已安装」列表里**？因为插件页列的是**声明了 `dsh.bundle` 的** profile 依赖。子路径刻意不声明，它就只是一个被补丁点名的普通模块 —— DSH 里插件包的常规形态。**装的那一层始终只有 `dsh-image-openai`。**

> 早期版本把工具层放在**另一个包** `dsh-image-openai-tool` 里。后来实测确认 `metaOf` 是按 specifier 而非包名解析的，子路径即可达到同样的分行显示效果，于是合并成了一个包：少一个包、少一个 `link:` 依赖、少一次安装。

### 开关拨的是「行」，不是「包」

拨包等于往 `dsh.profile.bundles` 里增删条目。曾经用这种写法时，一次组合层的清理把这个包从 bundles 里删掉了 —— 开关连同它自己一起消失。拨行只往 profile 补丁里写一条覆盖（`- id: image-openai-tool`），**完全不碰 bundles**，所以清理逻辑碰不到它。顺带：插件管理页那一行的开关和它拨的是同一份状态。

> ⚠️ **需要重启才生效是真的。** `setPluginEnabled` 和 `setBundleEnabled` 的返回值里 `application` 都有三个可能：`applied`（HMR 热应用）、`restart-required`（没有 HMR 的 profile，改动已存盘但下次启动才组合）、`failed`（报错）。桌面端 profile **没有启用 HMR**，所以在那里开关会落成 `restart-required`：状态已保存，重启 DSH 后生效。开关本身仍然会立刻反映保存后的状态。

## 用哪个模型

设置页面里的**模型提供商**下拉，列的是**你 profile 里已经配好的那些 `providers`**——它由宿主端从 Loader 自己的组合里读出来（即 `cordis.patch.yml` 里那段 `providers:` 配置），所以本机看到的是 `max66`。选中之后：

- **接口地址**和**密钥引用**自动带出该提供商的值；
- **图像模型**下拉列出该提供商声明的模型 id。

想用 DSH 完全不知道的服务，选「不指定」然后把地址和密钥引用手填进去即可。密钥本身**从不进入浏览器**：页面只传引用名，宿主端按「进程环境 → 凭证服务 → `$DSH_HOME/.credentials.yaml` 的 `refs:`」的顺序去解析。这也是为什么生成请求必须绕宿主一圈，而不能由页面直连。

## 它和 DSH 自带的 pi-ai 图像能力是什么关系

DSH 的 `@earendil-works/pi-ai` 确实有一个图像接口（`generateImages`），但它**只注册了 `openrouter-images` 一种 api**，实现走的是 `chat/completions` + `modalities: ["image","text"]`，**不是** OpenAI 的 `POST /v1/images/generations`。所以本插件没有复用它，而是自己实现 OpenAI 的这条图像协议：

```
POST <baseURL>/images/generations
{ "model": …, "prompt": …, "n": 1, "size": …, "response_format": "b64_json" }
```

返回的 `data[].b64_json` 和 `data[].url` **两种都支持**（网关实现不一致），拿到字节后写到磁盘，路径交回调用方。

## 写在哪儿

- 指定了 `outputDir` → 写那里；
- 模型调用（工具）→ 写进**会话工作目录**，这样模型之后能用 `present` 把它交给你；
- 页面直接生成、且没配目录 → 写 `$DSH_HOME/dsh-image-openai/`。

文件名是 `image-<ISO 时间戳>-<序号>.<扩展名>`，扩展名按返回的 MIME 类型决定。

## 安装

装**一个插件**：

```bash
dsh plugin --profile <你的 profile> add link:/绝对路径/dsh-image-openai
```

一条命令就够了。插件声明了 `dsh.bundle`，装完会被**自动**登记进 `dsh.profile.bundles`；它的补丁登记**两行**，第二行指向本包的 `./tool` 子路径，不需要单独安装任何东西。

> **桌面端（DSH Desktop）**：`--profile desktop` 由 Electron 应用独占，`dsh plugin` 会直接拒绝，所以桌面端这份要在应用内的插件管理入口里装。本机已按等价方式装好：profile 清单里是一条 `link:` 依赖 + bundles 里多出 `dsh-image-openai` 一层，`node_modules/dsh-image-openai` 是指向本仓库的符号链接（`link:` 开发时改完代码刷新页面即可生效）。

<details>
<summary>手动等价做法（不用 CLI）</summary>

编辑 `~/.dsh/profiles/<你的 profile>/package.json`：

```json
{
  "dependencies": {
    "dsh-image-openai": "link:/绝对路径/dsh-image-openai"
  },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-image-openai"
  ] } }
}
```

再把这个包链进该 profile 的 `node_modules`（`link:` 装法就是这个效果）。子路径 `dsh-image-openai/tool` 随包一起解析，无需额外的符号链接或依赖。

</details>

装好后插件页的「已安装」里会多出**一个**条目：**图像生成（OpenAI 兼容）**。点开它能看到两行，标题各不相同：

- **图像生成（OpenAI 兼容）** / `image-openai` —— 页面层，一直启用；
- **生成图片工具（可注入）** / `image-openai-tool` —— 工具层，输入框里那个开关拨的就是它。

## 配置

设置页面里填的值存在 harness 的 storage domain（`dsh_image_openai` 域 / `settings` 表的 `current` 记录）里，**重启后还在**。落盘位置就是该 storage backend 的域文件，比如 JSON backend 下是 `<root>/dsh_image_openai.json`。

> **一个 storage domain 不是 profile 配置出来的，而是用它的插件自己声明并 `open()` 的。**
> `storageDomain.get(name)` 只是查「已经开着的域」，先查后读必然查不到 —— 早先的版本就是这么写的，
> 于是每次保存都报 `storage domain "dsh_image_openai" is not mounted`（那句话是插件自己编的，
> 把矛头指向了 profile）。现在由插件声明规格并调用 `storageDomain.open(spec)`，页面行和工具行共享
> 同一个已开的域；域规格只有 `name` / `version: 1` / `settings` 表的校验器，`layout` 留空即
> backend 默认的 `single`（整个域一个文档，正合一行设置）。
> 没挂 storage 的 profile 也能跑：读失败就退回内存默认值，只有**保存**会明确报错。

也可以直接写在 profile 的 `cordis.patch.yml` 里当默认值，设置页面里留空即用默认：

```yaml
- id: image-openai
  name: 'dsh-image-openai'
  config:
    provider: max66          # 用哪个已配置的提供商
    model: gpt-image-1       # 图像模型 id
    baseURL: ''              # 留空则用 provider 的
    apiKeyEnv: ''            # 留空则用 provider 的
    size: auto
    quality: ''
    n: 1
    outputDir: ''
    promptPrefix: ''         # 每次生成前自动加的前缀
    extraJson: ''            # 额外请求字段，JSON 对象
    timeoutMs: 180000
```

写在哪一层都行——`config` 是那一行的，工具行也读同一份存储里的设置，所以两边看到的模型是同一个。**留空就是「设置页面说了算」。**

### `size` 默认是 `auto`

`auto` 的意思是**让服务端按提示词自己挑比例** —— 竖构图的人像通常就返回 1024×1536。不写这个字段时端点本来也是这个行为，现在把它写明，免得设置页里一个空格子看起来像"没设置"，而实际含义是"服务端定"。

想固定比例就填 `1024x1024`（方）、`1536x1024`（横）、`1024x1536`（竖）。注意 **`auto` 只有 gpt-image 系列认**：用 dall-e-3 / dall-e-2 时请填具体尺寸（它们分别是 `1792x1024`/`1024x1792`/`1024x1024` 与 `256x256`/`512x512`/`1024x1024`），`auto` 会被端点拒绝。

工具调用时传的 `size` 优先于设置页；传空字符串等于没传，仍然用设置里的值。写错格式（比如 `huge`）会在**发请求之前**被拒，不花额度。

### `apiKeyEnv` 是「引用名」，不是密钥 —— 而且通常留空

设置页里那个框叫**密钥引用**，它填的是**名字**，不是密钥本身。**留空就是正常用法**：选了 `provider` 之后，插件会照抄那个 provider 在 profile 里声明的 `apiKeyEnv`，再去取值。比如本仓库的示例 profile 里：

```yaml
- id: hi-code
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    provider: hi-code
    apiKeyEnv: HI_CODE_API_KEY     # ← 这个名字是 DSH 自己起的
```

值呢？在 `$DSH_HOME/.credentials.yaml` 的 `refs:` 里（`HI_CODE_API_KEY`、`MAX66_API_KEY`⋯⋯）。所以模型服务已经配好的密钥，图片这边**不需要再填一遍**。

**取值走 harness 自己的凭据 seam**（`ctx.credentials.resolve(name)`），也就是 DSH 解析 `apiKeyEnv` 用的同一个组件：启动环境 → 托管文档 → 项目/家目录 `.env`，这套优先级由它实现，插件不自己排序。seam 不存在时才退回读进程环境，最后才自己读那个文件。

> 设置页与存储之间**没有缓存**：每次请求都按刚读到的文档回答，读到的文档同时决定面板显示什么和 `stored` 字段是什么。曾经这一处用了缓存，于是重启后第一次打开设置页会看到一个几乎空白的表单（只有行配置），看起来就像"保存没生效" —— 而文档一直在磁盘上。`test/storage.mjs` 现在直接驱动真实的请求处理器来盯这件事。
>
> 这里踩过两个叠在一起的坑，都值得记下来：
>
> 1. **seam 的方法叫 `resolve`，不是 `get`。** 它答复的是 `{ value, source } | undefined`。插件原先探测的是 `credentials.get(...)` —— 没有这个方法，于是**静默跳过** seam，然后倒在自己手写的那条兜底路上。探测一个不存在的 API，和桩一个"会返回我要的东西"的服务，是同一类错误：`test/credential.mjs` 现在拿**真实的** provider 断言 `get` 不存在、`resolve` 才有答案。
> 2. **桌面宿主根本没有 `DSH_HOME`**，只有 `HOME`。兜底路径却硬要求这个变量，取不到就直接返回空 —— 一把就躺在 `~/.dsh/.credentials.yaml` 里的密钥，被报成 `credential "HI_CODE_API_KEY" is not set`。现在全文件只有一个 `dshHome()`（`DSH_HOME` → `~/.dsh`），静态自检盯着"只有它俩能读这两个变量"。

> 早先的界面把 provider 的 `apiKeyEnv` 当**灰色占位提示**画在空框里，看上去就像"请在这里填 `HI_CODE_API_KEY`"。现在标签直接写成**「密钥引用（留空即可）」**——不解释、不加说明行，占位提示仍然显示所选提供商的引用名。
>
> 只有两种情况需要真的填：选「不指定（使用下面的地址）」自己填 baseURL，或者你想用**另一把**密钥。填了名字但取不到值，生成时会**在发请求之前**报 `credential "…" is not set`（自检里有一条盯着这个：不能拿一次 401 去换一个本地就能说清的错误）。

## 行为与边界

- **试生成与工具走同一个实现。** 设置页面上的「生成图片」和模型的 `generate_image` 调用的是同一个 `generateImages()`（同一个模块，`role` 决定跑哪一半），所以两边不可能生成得不一样。
- **工具只在被注入时存在。** 未注入时模型看不到 `generate_image`，也不知道这个插件存在。
- **开关关掉的是工具行，不是页面行。** 页面行永远在，所以开关永远点得回来——这是两行而不是一行的全部理由（见上）。
- **自定义请求头是必需的，不是装饰。** 路由要求 `x-dsh-image-openai` 头：自定义头会强制 CORS 预检，而本服务不应答预检，所以外部页面无法调用（否则任何网页都能花你的图像额度）。**读接口也一样要求**——`GET /settings` 会回显你的提供商结构。
- **`/settings` 不返回密钥值**，只返回引用名。
- **失败的措辞尽量来自上游。** 模型名写错是最常见的失败，提供商的原文比转述有用，所以错误信息里保留它（截断到 400 字符）。
- **时间上限默认 180 秒**，可用 `timeoutMs` 调整；超时按 504 报告。
- **`n` 只影响一次请求要几张图**，不是循环调用。
- **`image` 只决定走哪条接口，不改变别的东西。** 同一个模型、同一份设置、同样的超时与落盘规则；文字生图和图生图共用一套超时、回包解析和错误措辞，所以不会出现「一条修好了另一条还是坏的」。
- **不做 mask / 局部重绘，一次只接受一张输入图。** 编辑接口本身支持更多，这里只实现了「给一张图 + 一句话」这一种。

## 它是怎么实现的

- **宿主半边做三件客户端做不到的事**：走 HTTP（浏览器有 CORS、且密钥不能下发）、落盘（图片要有可读路径）、注册工具（`ctx.tools` 是宿主服务）。
- **两条接口共用一个 `requestImages`**：只有 body 的构造不同（JSON vs `FormData`）。超时、中止、`b64_json`/`url` 两种回包的解析、错误措辞都在同一处，所以不可能只修好其中一条。
- **工具 schema 是手写的「编译后」形式，没有用 `defineTool`。** 这不是偏好，是被迫的：`defineTool` 是 `@deepseek-ai/dsh-tools` 的**模块导出**，装在 app 之外的插件 import 不到——裸包名从 profile 目录解析（那里没有 `@deepseek-ai/*`），而软链进 asar 会晚一步死在 Node 的 ESM 包解析器上（它读 `package.json` 用的是没打 asar 补丁的内部实现，`ERR_MODULE_NOT_FOUND`，文件明明在）。好在注册表本来就是**按 JSON Schema 消费** `definition.parameters`（`schemaOf` 原样快照，要求是"lossless JSON"），`defineTool` 做的只是把 DSL 编译成它。所以这里直接写编译结果，`test/tool-schema.mjs` 拿**宿主自己的 `defineTool`** 编译等价 DSL 再逐字段比对，并真的注册进**真实的 `ToolRuntime`** 验证模型能看到它。
  - 代价是失去 `defineTool` 的自动参数校验（`ToolArgsError`）。改由 `execute` 自己校验，抛错同样变成一次错误工具结果。
- **工具行的 `inject` 是 `['tools']`**（`tool/index.js` 里声明）：这一行离开注册表毫无意义，所以让它在没有 `tools` 的 profile 里**不激活**，而不是半生效。页面那一行不声明——它只服务 HTTP 路由和客户端开关，用户不开工具时也必须能用。
- **注册一律由 `ctx.effect` 持有**，`tools` 与 `webServer` 都是**探测式**获取（属性形式 + `ctx.get` 兜底），所以终端 profile 这种没有 webServer 的组合不会崩，只是没有 HTTP 入口。
- **拿不到注册表就大声说出来**（`ctx.logger.warn`），绝不静默返回。上一版正是静默返回：`ctx.get('dsh-tools')` 是个不存在的服务名，取到 `undefined`，函数直接 `return`——行激活了、日志空白、模型没有工具，用户只能从"模型说它没这个工具"倒推。
- **不通过 context 服务共享状态。** `ctx.set(name, value)` 只能**覆盖**一个已经被 `provide` 过的服务，用它发布新服务会在激活时抛 `cannot set property "…" without provide` 并把整个插件打黑。共享状态走闭包参数。
- **客户端半边只 `require('react')`**，不 import 任何 Harness Client 包——纯 JS 插件没有类型检查，而抛异常的组件会让整个插槽条目变空白。样式只用 `--dsw-*` 主题 token，明暗自动跟随。
- **两个插槽，各司其职。** 开关注册进 `conversation.input.left`（composer 工具行的左侧一组，`InputBar` 源码里就在 `conversation.input.permission` 之后，带 `id` 与 `order`；这个插槽此前没有占用者）；设置页面注册进 `plugins.row.config`，键是 `<包名>#<行 id>`——就是插件管理器 `rowConfigKey()` 的拼法，注册了这个键，那一行才会长出**配置**入口。契约里特意写明这个插槽的 `form` 是可选的：本插件的设置是自己的存储文档，不是 Host 托管的 config 命名空间，所以页面自己画控件、自己走路由。
- **路由处理器签名是 `(req, res)`**，服务器只匹配路径、不传路径进来，所以子路径由处理器自己从 `req.url` 推出。这个基址只剥一次——剥两次会把 `/settings` 变成 `ttings`（自检里有一条专门盯着这个）。
- **`ctx.remote.pluginManager` 是属性，不是 promise**：写 `await ctx.remote.pluginManager.listBundles()`，不是 `(await ctx.remote.pluginManager).listBundles()`。
- **Remote 调用返回信封，不是裸数据**：每次调用答复的是 `{ ok: true, value }` 或 `{ ok: false, error }`。所以数组在 `answer.value` 里，`application` 在 `answer.value.application` 里，而**被拒绝的调用是 resolve 而不是 reject** —— 只写 `try/catch` 会把"被拒绝"读成"成功"。这一条踩过：直接把 `listBundles()` 的返回值当数组用，就是 `bundles.find is not a function`。
- **`inject` 要逐段写**：Cordis 按属性逐段解析服务，只写 `remote.pluginManager` 而不写 `remote`，第一次访问就会抛 `cannot get property "remote" without inject`。官方插件管理页同样把 `remote` 和 `remote.pluginManager` 并列声明。
- **客户端取服务用属性，不用 `ctx.get`**：`ctx.get(...)` 是宿主端的写法，客户端上它返回 `undefined` —— 而且**不报错**，只是静默降级（这一条踩过：用它读 `locale` 导致界面永远是英文）。
- **开关会区分「已保存」和「已生效」**：这个 profile 没有热重载，`setPluginEnabled` 一律返回 `restart-required`。把它显示成"已注入"等于骗人——用户只有问模型才会发现工具还没上线。所以轨道改成描边、提示写清楚"重启后生效"，**面板上仍然是「生成图片」四个字**。

## 开发

六套自检，退出码非零即失败。

**一、静态自检**（零依赖、离线）——清单字段、组合包层与开关契约、两行的 specifier 归属与显示元数据（含子路径的 `exports` 是否放行了 locale 与 manifest）、路由与请求头在两边的拼写、设置合并、凭证文档解析、工具 schema、storage 域规格、插槽注册与主题 token：

```bash
node test/check.mjs        # 或 pnpm test
```

**二、开关渲染自检**（零依赖）——把客户端半边真的渲染出来（`window.__ModuleLoader__` + 一个保持状态、按依赖重跑 effect 的 React mock），然后点它：拨的是不是**工具行**、`restart-required` 有没有显示成「重启后生效」、被拒绝时有没有退回原状态、行找不到时是不是禁用并给出中文原因，以及**面板文字是不是始终「生成图片」四个字**：

```bash
pnpm test:switch          # node test/switch.mjs
```

**三、请求构造自检**（零依赖）——把 `fetch` 换成假的，真的跑一遍：不带 `image` 是不是发到 `/images/generations` 且 body 是 JSON；带 `image` 是不是发到 `/images/edits` 且 body 是 `FormData`、**有没有手写 content-type**；上传的字节与文件名对不对；按字节判类型；相对路径按 cwd 解析；坏路径 / 非图片 / 目录 / 空字符串各自的处理；404 的措辞；无密钥时不发 `authorization`：

```bash
pnpm test:generate
```

**四、凭据自检**（借 app 的 Node）——挂载**真实的** `@deepseek-ai/dsh-credentials-local`（喂一份临时文档和假密钥，**绝不读你的真凭证**），断言：seam 的方法确实是 `resolve` 而不是 `get`；文档里的密钥能一路走到请求的 `authorization` 头；指名了但取不到就**在发请求前**按名字报错；没有 `DSH_HOME` 时兜底能找到 `~/.dsh`；`DSH_HOME` 优先于 `HOME`；seam 坏掉时会退回进程环境而不是抛出去。`fetch` 是假的，**零费用**：

```bash
pnpm test:credential
```

**五、工具 schema 自检**（借 app 的 Node）——用真实的 `defineTool` 编译等价 DSL，跟本插件手写的常量逐字段比对；再用真实的 `assertSupportedJsonSchema` 验证落在受支持的子集内；最后**注册进真实的 `ToolRuntime`**，确认 `view()` 里出现 `generate_image`、`schemas()` 投影出 `required: ['prompt']`：

```bash
pnpm test:schema
```

**六、storage 集成自检**——用**真实的** `@deepseek-ai/dsh-storage-domain` 设施（以及真实的 JSON backend 落盘）跑一遍本插件的 `settingsDomain` / `writeSettings` / `readSettings`，验证域能开、值能落盘、重开还在、非法记录会在 open 时被规格校验器纠正：

```bash
pnpm test:storage
```

（就是 `ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/DeepSeek Harness" test/storage.mjs`；普通 `node` 解析不到 asar 里的 `@deepseek-ai/*`，所以必须借 app 自己的 Node。）

**这一套是补上来的。** `check.mjs` 里当初把 `storageDomain.get()` 桩成返回一个域，于是测试全绿、插件全坏 —— 真机上根本没人**开**过那个域。凡是靠「服务会返回我要的东西」的假设，都得有一处拿真实实现跑过。

## 兼容性

针对 DSH 的 client-modules 协议构建：一个 classic script，通过 `window.__ModuleLoader__.load({ id, factory })` 注册工厂，只从 `react` 取依赖。依赖宿主服务 `tools`、`webServer`（可选）、`storageDomain`（可选，缺了就只记在内存里）、`loader`、`credentials`（可选），以及客户端 `slots`、`remote.pluginManager`、`locale`。工具与路由都做了能力探测，缺哪个就少哪一项功能。

## License

[MIT](LICENSE)
