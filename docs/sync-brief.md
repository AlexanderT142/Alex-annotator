# PDF Annotator 多设备同步：现状与问题说明

> 用途：发给其他 AI / 合作者讨论方案。希望得到**不同思路**，不只是对下面方案的修补。

## 1. 背景

**PDF Annotator** 是一个 Obsidian 社区插件（TypeScript，仅支持桌面端，`isDesktopOnly: true`）。它在 Obsidian 自带的 PDF 阅读器上提供以下功能：

- 高亮、下划线、框选等标记，并可附带笔记
- 页面便签（tag）和区域框（region）
- **标注集**：同一个 PDF 上可以叠多层批注，比如"我的笔记""翻译""AI 伴读"，每层可以单独显示或隐藏
- AI 批注：用户自己提供 API key，让 AI 往指定的标注集里写批注

GitHub 上有用户提了 issue，大意是：

> 这是 Obsidian 里最好的 PDF 批注插件，但我的批注没法通过 Obsidian Sync 同步，有什么办法吗？

## 2. 现在的存储方式

### 2.1 目录结构

插件用 PDF 文件内容的 SHA-256 作为文档的身份标识，所以 PDF 改名或移动后，批注依然能对上。所有数据都存在 vault 里的一个**隐藏文件夹**中：

```text
.pdf-annotator/bundles/sha256/<hash>/
  document.pdf                 # PDF 的完整备份（用于误删后恢复）
  annotations.md               # 旧格式，迁移用
  annotation-sets/
    index.json                 # 标注集列表、哪些可见、当前写入哪个集
    index.previous.json        # 上一次的备份
    default.md                 # 一个标注集一个文件
    <set-id>.md
    <set-id>.previous.md       # 上一次的备份
  ai-jobs/<job-id>.json        # AI 任务进度
  manifest.json                # 路径别名、校验和、时间戳等
```

每个标注集的 `.md` 文件分两部分：一段可读的 Markdown 摘要，再加一个 fenced JSON 代码块，后者才是真正被程序读取的数据。

### 2.2 数据结构（简化）

```ts
interface Highlight {
  id: string;
  type?: "highlight" | "tag";
  page: number;
  color: string;
  style?: MarkStyle;
  text: string;          // 被选中的原文
  note?: string;         // 用户笔记
  noteContentCJK?: string; // 旁注
  rects: PdfRect[];      // PDF 坐标
  tagX?, tagY?, tagWidth?, tagHeight?: number;
  tagStyle?: "label" | "region";
  isPinned?: boolean;
  marginSide?: "left" | "right" | "auto";
  created: string;       // ISO 时间
  source?: "manual" | "import" | "ai";
  setId?: string;
  ai?: { jobId; provider; model; generatedAt };
}

interface AnnotationSetIndex {
  activeSetId: string;      // 当前写入的集
  visibleSetIds: string[];  // 显示哪些集
  sets: { id; name; kind; accent; created; updated; archived? }[];
}
```

### 2.3 读写方式

- 打开 PDF 时，把整个标注集文件**读一次**到内存里。
- 每次修改后，把**整个文件重写一遍**。同一台设备上的写入会排队依次执行，但不会再从磁盘读回来。
- 插件用的是底层的 `vault.adapter`（直接读写文件），不经过 Obsidian 的文件索引。插件监听了 PDF 的 `rename` 和 `delete` 事件，**没有**监听批注文件的修改。

## 3. 问题出在哪

### 3.1 根本同步不了

Obsidian Sync **不会同步以点开头的文件夹**（只有 `.obsidian` 配置文件夹例外），也没有办法手动把这类文件夹加进去。所以 `.pdf-annotator/` 里的东西完全不会被同步。

（README 里写着"如果你的同步工具排除隐藏文件夹，请手动包含 `.pdf-annotator/`"，但这一点 Obsidian Sync 做不到。）

### 3.2 就算能同步，也会出错

即使把文件夹改成普通文件夹，下面这些问题依然存在：

1. **整文件覆盖**：A、B 两台设备都改过同一个标注集，同步工具只能留下其中一份，或者生成冲突副本，另一边的修改就丢了。
2. **没有修改时间**：每条批注只有 `created`，没有 `updated`，因此无法判断哪一边的版本更新。
3. **删除不留记录**：删除批注就是直接从数组里移除。另一台设备分不清"这条被删掉了"和"这条我还没收到"，合并时可能让已删除的批注重新出现。
4. **不会自动刷新**：PDF 打开期间如果同步带来了新数据，内存里的旧数据会在下次保存时把它覆盖掉。
5. **PDF 备份占双倍空间**：每个 bundle 里都有一份 `document.pdf`，同步时每个 PDF 都要传两份，可能碰到 Obsidian Sync 的单文件大小限制或总容量限制。

### 3.3 用户的真实期待

用户想要的是**真正的同步**：在一台设备上批注，到另一台设备打开就能看到。不需要手动合并，不出现多个版本，也不丢数据。只是"挪个文件夹，然后祈祷别冲突"是不够的。

## 4. 限制条件

- **不想搭服务器**，也不想做账号系统（维护成本高，还涉及隐私）。
- 最好能**兼容各种同步工具**：Obsidian Sync、iCloud、Syncthing、Git、Dropbox 等。这些工具只认文件，大多是"最后写入的赢"，或者生成冲突副本。Obsidian Sync 对 `.md` 文件会尝试按文本合并，但对嵌在 Markdown 里的 JSON 来说，按文本合并很可能把 JSON 弄坏。
- **数据要能读懂**：用户的笔记最好仍然是人能直接读的文件，而不是一个数据库二进制文件。
- **兼容老用户**：已有数据要能自动迁移，用户不需要手动操作。
- 插件**目前只支持桌面端**。如果用户想在 iPad 或手机上同步，就还得解决移动端运行的问题（pdf.js、文件 API、性能等）。
- 实现复杂度要可控，最好不引入很重的依赖。

## 5. 目前想到的方案（供参考，欢迎推翻）

**核心思路：每台设备只写自己的文件，读的时候再合并。**

```text
PDF Annotator/<hash>/sets/<set-id>/
  device-A.json
  device-B.json
```

1. 每台设备有一个固定的 deviceId，**只写自己的那个文件**。一个文件永远只有一个设备在写，所以同步工具不会产生冲突。
2. 读取时把所有设备的文件读进来，按批注 `id` 合并。
3. 每条批注、每个字段都记一个修改时间，合并时**按字段取较新的值**：一边改颜色、一边改笔记，两个修改都能保留。
4. 用**混合逻辑时钟（HLC）**代替纯本机时间，避免某台设备时钟不准导致旧数据总是赢。
5. 删除时保留一个"已删除"标记，并且不清理，避免离线很久的设备把已删除的批注"复活"。
6. 文件夹改成非隐藏的，并监听文件变化，同步数据到达时自动刷新正在打开的 PDF。
7. PDF 备份 `document.pdf` 仍然放在本机的隐藏文件夹里，不参与同步。
8. 可能加一个"启用同步"开关，只对需要同步的用户迁移数据。

**这个方案的已知缺点：**

- 新文件夹会出现在 Obsidian 的文件列表里，不太好看。
- 同一条批注的同一个字段如果两边同时改，只能保留较新的那个（笔记文字不会被合并）。
- 设备文件会越来越多，比如重装插件会生成新的 deviceId。
- 存储层要重写，工作量不算小。

## 6. 还没定的问题

1. 标注集的"显示/隐藏"和"当前写入哪个集"，应该跨设备同步，还是每台设备各自记？
2. 默认对所有人开启，还是做成一个开关？
3. 笔记文字有没有必要做更细的合并（比如按段落合并，或者用文本 CRDT）？还是保留较新版本就够了？
4. 是否值得为同步支持移动端？

## 7. 想请你帮忙思考的

- 有没有**完全不同的思路**？比如：
  - 把批注写进 PDF 文件本身（标准 PDF annotation）？
  - 利用 Obsidian Sync 对 `.md` 的文本合并能力，把数据设计成"天然能按行合并"的格式？
  - 用只追加的操作日志（op log）代替"保存最新状态"？
  - 现成的 CRDT 库（Yjs、Automerge）是否值得引入，有多重？
  - 其他 Obsidian 插件（Excalidraw、Kanban、各种 PDF/批注插件）是怎么处理同步的？
- 上面的方案里有没有**会出大问题的地方**？
- 有没有办法**让隐藏文件夹也能被 Obsidian Sync 同步**，或者让数据所在的文件夹在文件列表里不那么显眼？
- 如果只能做一个"最小但真正可靠"的版本，你会砍掉哪些部分？
