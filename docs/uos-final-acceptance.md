# 最终安装形态 — 目标机验收（交给测试人的那一页）

> 本轮验收的对象是**最终安装形态**，不是 RC1.1 候选包。
> RC1.1 验证的是「BusyBox 能否正确提供这个应用」；本轮验证的是「装好之后，从菜单点开、
> 日常使用、升级、回退、卸载，是不是都对」。
>
> **Phase 3 尚未完成。** 本轮证据回来并通过审核之前，不得声称该工作站已验证。

## 一、需要哪两个包（四个文件）

| 文件                                                                | 用途           |
| ------------------------------------------------------------------- | -------------- |
| `civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz`             | 安装包         |
| `civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz.sha256`      | 安装包校验值   |
| `civic-work-desk-uos20-final-acceptance-2026.09.23-5.tar.gz`        | 验收工具与表格 |
| `civic-work-desk-uos20-final-acceptance-2026.09.23-5.tar.gz.sha256` | 验收包校验值   |

安装包 SHA-256：

```
969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf
```

验收包 SHA-256：

```
ac77a6e58eebb214acf16707d2a7e67a3aca2b98a36f8e55823822fee3680b30
```

## 二、最少要敲的命令

**两个包都要先校验再解压。** 验收包自己也必须可信——它损坏了，它跑出来的结论就都不可信。

```sh
sha256sum -c civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz.sha256
sha256sum -c civic-work-desk-uos20-final-acceptance-2026.09.23-5.tar.gz.sha256

tar -xzf civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz
tar -xzf civic-work-desk-uos20-final-acceptance-2026.09.23-5.tar.gz

cd civic-work-desk-uos20-loongarch64-2026.09.23-5
sha256sum -c SHA256SUMS.txt | tail -n 2
sh install.sh
```

两条外层校验都必须显示 `OK`。任何一条不是 `OK` 就停下，不要解压。

然后按验收手册逐项做：

```sh
cd ../civic-work-desk-uos20-final-acceptance-2026.09.23-5
sha256sum -c SHA256SUMS.txt | tail -n 2
cat FINAL_ACCEPTANCE.md
```

端口冲突一项请务必用脚本，不要手工造冲突（脚本做完会把服务恢复成运行状态）：

```sh
sh scripts/port-conflict-test.sh
```

**收集证据必须在卸载之前**：

```sh
sh scripts/collect-results.sh
```

最后才卸载，然后做卸载后检查：

```sh
$HOME/.local/bin/civic-work-desk-uninstall
sh scripts/post-uninstall-check.sh
```

## 三、两条顺序纪律

1. **`collect-results.sh` 必须在卸载之前跑。** 卸载会删掉程序文件、菜单项、运行状态和部署日志
   ——正是收集脚本要采集的全部内容。反过来做只会收集到一份「未安装」，最有力的自动化证据就没了。
2. **端口冲突脚本结束时会恢复正常服务**，所以之后才能正常测 stop。

## 四、命令都用绝对路径

手册里所有命令都写成 `$HOME/.local/bin/...`。`~/.local/bin` 不一定在 PATH 里，
直接敲 `civic-work-desk-status` 可能报「找不到命令」——那是 PATH 的问题，不是产品的问题，
会造成误判。

## 五、必须实测的项目

按手册顺序：两个包的外层与包内校验 · 无 sudo 安装 · 菜单启动 · 重复点击（幂等）·
地址逐字核对 · 360 浏览器与配置 · 无白屏无报错 · 假数据的新建/编辑/持久化 ·
停止再启动服务 · 关闭再打开浏览器 · JSON 备份与精确恢复 · XLSX/DOCX · 离线运行 ·
端口冲突失败路径与服务恢复 · status · stop · **卸载前收集证据** · 卸载与卸载后检查 ·
升级（若同时给了两个版本）· 整机重启（若可行）。

## 六、本轮必须补上的浏览器证据

上一轮没有测到，这一轮要补。在应用页面按 F12 打开 Console，粘贴手册第四节那段代码，
把输出的 JSON 原样抄回。要拿到的是这六项加两项：

`location.origin` · `'indexedDB' in window` · `'serviceWorker' in navigator` ·
`'caches' in window` · `typeof crypto.subtle` · `typeof crypto.randomUUID` ·
Service Worker 注册数量 · Cache Storage 的 key 列表。

应用本身**没有**为此增加任何代码；这段是验收时临时粘贴的。

## 七、两条纪律

1. **没做的项目写 N/A，不要写 PASS。** 整机重启这一项上一轮就是这样处理的，这一轮同样。
2. **全程只用编造的假数据。** 不要录入真实人名、单位、事由或文号；测试产生的报表与备份
   测试结束后自行删除。

## 八、关于服务日志（不要据此判 FAIL）

BusyBox httpd 不加 `-v` 时**不记录请求行**，所以 `httpd.log` 正常应当是**空的**。
空日志不是故障，恰好是我们要的：不记录访问路径。服务是否正常看
`$HOME/.local/bin/civic-work-desk-status` 的健康检查，不看日志有没有内容。

（RC1.1 手册里那句「日志里必须能看到原始路径」对 BusyBox 不成立，会导致误判；已更正。）

## 九、回传什么

- 填好的 `RESULT_TEMPLATE.md`
- `civic-work-desk-final-results-<时间>.txt`（**卸载前**收集的）
- `civic-work-desk-post-uninstall-<时间>.txt`（卸载后检查）
- 第六节那段 JSON
- `port-conflict-test.sh` 的完整输出
- 失败项的截图（**只有失败时才需要**）

回传前请确认：没有真实业务数据、没有浏览器历史或 Cookie、没有个人文档。
账号名如不希望外传，可自行把路径里的账号替换为 `user`。

## 十、验收通过之后才能说的话

现在能说的，是两件不同的事：

- **已实测**：本应用由 BusyBox 提供静态服务时的行为，在该机型该浏览器上（RC1.1）；
- **未实测**：本包的安装器与启动器全流程（安装、启动、升级、回退、卸载）。

本轮通过之后，适用范围的表述才可以是：

> 已在 UOS Desktop 20 Professional、loongarch64 / 龙芯 3A6000、内核
> 4.19.0-loongson-3-desktop、360 安全浏览器 13.4.1140.83（Chromium 126.0.6478.251）上
> 完成安装形态验证。

不得扩展为「支持 Linux」「支持 UOS」「支持龙芯」。证据只覆盖这一台机器的这套环境。
