# CivicWorkDesk UOS RC1 — 目标机验收手册

这是在**那台统信 UOS 工作站上**要做的事。按顺序做，边做边把结果填进
`acceptance/RESULT_TEMPLATE.md`，最后用 `scripts/collect-results.sh` 打包回传。

## 开始之前

**全程不需要 sudo。** 任何一步要求输入密码，都说明哪里不对，请停下并记录。

**这次测试只用测试数据。** 不要导入真实的工作记录。本次验收的目的之一，就是在真实数据进入之前
确认这套部署是可靠的。

**本次不安装任何东西。** RC1 全部在解压出来的目录里运行，不写入系统目录，不修改浏览器设置，
不改动默认浏览器关联。

约定的固定地址（下文称「规范地址」）：

```
http://127.0.0.1:8765/
```

这个地址是部署契约的一部分。`localhost:8765` 不等价，其他端口不等价，另一个浏览器
配置文件也不等价——浏览器按「来源」隔离本地数据，换了来源，已有数据会看起来消失。

---

## 第 1 步 · 校验文件完整性

```sh
cd <解压出来的 civic-work-desk-uos-rc1 目录>
sh scripts/verify-files.sh
```

**期望**：最后一行是「结果：通过」。
**如果失败**：不要继续。重新传输整个包。

---

## 第 2 步 · 运行只读探针

```sh
sh scripts/probe-target.sh
```

它只读取信息，不安装、不修改、不启动任何服务。结束时会打印报告路径
（`scripts/civic-work-desk-probe-<时间>.txt`）。

**请先打开这份报告看一眼**，特别是：

- 第 4 节 BusyBox 是否有 `httpd` 小程序，以及 `busybox httpd --help` 的实际输出；
- 第 5 节 `xdg-settings get default-web-browser` 的结果；
- 第 8 节 端口 8765 是否空闲。

---

## 第 3 步 · 确认端口 8765 空闲

```sh
ss -ltnp | grep 8765 || echo "端口 8765 空闲"
```

**如果被占用**：停止验收，在结果表里记录占用者（如果能安全看到），并等待重新分配一个固定端口。
**不要**改用其他端口继续测试——端口是部署契约的一部分。

---

## 第 4 步 · 启动候选服务 A（BusyBox）

```sh
sh candidate/busybox/start-test.sh
```

**期望**：打印「已启动 BusyBox httpd（PID …）」和规范地址。

**如果 BusyBox 这一步就失败**（没有 httpd 小程序、不认 `-c` 参数、立即退出），记录完整错误，
然后跳到第 4b 步测试候选方案 B。

### 第 4b 步 · 候选服务 B（Python，仅在 A 失败或 A 的表现不合格时）

先确保 A 已停止（`sh candidate/busybox/stop-test.sh`），然后：

```sh
python3 candidate/python/server.py --root app
```

它在前台运行，按 Ctrl-C 停止。

---

## 第 5 步 · 确认只监听回环地址

```sh
ss -ltn | grep 8765
```

**期望**：地址一列显示 `127.0.0.1:8765`。
**不合格**：如果显示 `0.0.0.0:8765` 或 `*:8765`，说明服务对局域网开放，请立即停止服务并记录。

---

## 第 6 步 · 抓取真实响应头（这一步很重要）

不要凭文档推断 MIME 类型，要看实际返回了什么。把 `<JS 文件名>` 换成
`app/assets/` 下真实的 `index-*.js` 文件名。

```sh
mkdir -p .runtime
{
  for p in / /index.html /sw.js /manifest.webmanifest /deployment-health.json; do
    echo "--- $p"
    curl -s -o /dev/null -D - "http://127.0.0.1:8765$p"
  done
  echo "--- /assets/<JS 文件名>"
  curl -s -o /dev/null -D - "http://127.0.0.1:8765/assets/<JS 文件名>"
  echo "--- 目录遍历（应为 404）"
  curl -s -o /dev/null -D - "http://127.0.0.1:8765/../SHA256SUMS.txt"
  echo "--- 目录列表（应为 404）"
  curl -s -o /dev/null -D - "http://127.0.0.1:8765/assets/"
} > .runtime/headers-busybox.txt 2>&1
```

如果机器上没有 `curl`，用 `busybox wget -S -O /dev/null <地址>` 代替，把输出重定向到同一个文件。

**逐条核对并填表**：

| 检查项                    | 合格标准                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/` 与 `/index.html`      | `Content-Type` 是 `text/html`                                                                                          |
| `/assets/*.js`            | `Content-Type` 是 `text/javascript` 或 `application/javascript`（**不能**是 `text/plain`、`application/octet-stream`） |
| `/assets/*.css`           | `Content-Type` 是 `text/css`                                                                                           |
| `/sw.js`                  | JavaScript 类型（同上）——这条不合格，Service Worker 无法注册                                                           |
| `/manifest.webmanifest`   | 有返回即可；类型最好是 `application/manifest+json` 或 `application/json`                                               |
| `/deployment-health.json` | `application/json`                                                                                                     |
| 目录遍历                  | 404 或 403，**不能**返回 `SHA256SUMS.txt` 的内容                                                                       |
| 目录列表                  | 404 或 403，**不能**列出文件名                                                                                         |

`.js` 的类型是最关键的一条：Chromium 会拒绝以非 JavaScript 类型返回的模块脚本，表现是
**白屏加控制台报错**，而不是服务器报错。

---

## 第 7 步 · 打开应用

优先用系统默认方式：

```sh
xdg-open http://127.0.0.1:8765/
```

**确认打开的是 360 浏览器**。如果打开的是别的浏览器：

- **不要**去修改系统默认浏览器设置；
- 在结果表里记录实际打开的是什么；
- 改用直接调用的方式再试一次：

```sh
/opt/apps/com.360.browser-stable/files/com.360.browser-stable http://127.0.0.1:8765/
```

**不要**加任何命令行参数，**不要**用无痕模式，**不要**指定新的用户数据目录——那会创建一个新的
浏览器配置，里面的本地数据是空的，容易被误认为数据丢失。

---

## 第 8 步 · 应用启动验收

| 检查项 | 合格标准                                             |
| ------ | ---------------------------------------------------- |
| 首屏   | 不是白屏；能看到「政务工作记录台」和顶部导航         |
| 控制台 | 没有红色报错（按 F12 打开开发者工具 → Console）      |
| 中文   | 字形正常，无方块、无乱码                             |
| 导航   | 概览 / 工作 / 荣誉 / 台账 / 报告 / 设置 六项都能点开 |
| 布局   | 在这台机器的实际分辨率下排版正常，不重叠、不溢出     |

在「设置 → 存储与诊断」里，把页面上显示的存储与诊断信息记录到结果表。

---

## 第 9 步 · 浏览器平台能力

在开发者工具的 Console 里逐条粘贴执行，把输出记录到结果表：

```js
// 1. IndexedDB
indexedDB.databases
  ? indexedDB.databases().then((d) => console.log('DB:', d))
  : console.log('DB: databases() 不可用（不影响使用）');

// 2. Service Worker
navigator.serviceWorker.getRegistrations().then((r) =>
  console.log(
    'SW 注册数:',
    r.length,
    r.map((x) => x.scope),
  ),
);

// 3. Cache Storage
caches.keys().then((k) => console.log('Cache:', k));

// 4. crypto.subtle（备份校验和依赖它）
console.log('crypto.subtle:', typeof crypto.subtle, '| randomUUID:', typeof crypto.randomUUID);

// 5. 当前来源（必须与规范地址一致）
console.log('origin:', location.origin);
```

**关键**：第 5 条必须输出 `http://127.0.0.1:8765`。
**关键**：第 4 条 `crypto.subtle` 必须是 `object`，否则无法生成备份校验和。

Service Worker 注册数为 0 不一定是失败——首次加载可能还没注册完，刷新一次再看。

---

## 第 10 步 · 核心业务流程（用测试数据）

依次做完，每步记录成功 / 失败：

1. 新增一条工作记录（标题写「测试事项 001」之类，**不要用真实内容**）；
2. 编辑刚才那条记录；
3. 给它添加一条进展；
4. 新增一条荣誉，并关联到这条工作记录；
5. 在工作列表里搜索「测试」，确认能筛到；
6. 打开台账，确认表格显示正常、可横向滚动、表头行为正常；
7. 打开报告，选一个月份，生成预览。

---

## 第 11 步 · 持久化

| 步骤                                                          | 期望     |
| ------------------------------------------------------------- | -------- |
| 刷新页面（F5）                                                | 数据还在 |
| 完全关闭浏览器再打开，访问规范地址                            | 数据还在 |
| 停止服务（`sh candidate/busybox/stop-test.sh`），再启动，刷新 | 数据还在 |
| 如果条件允许：重启工作站，重新启动服务并打开                  | 数据还在 |

**任何一步数据消失，都要立刻记录当时的地址栏内容**——最常见的原因是地址变成了
`localhost:8765` 或别的端口，那是另一个存储空间，不是数据丢失。

---

## 第 12 步 · 备份与还原

1. 「设置 → 数据与备份 → 导出 JSON 备份」，确认下载成功，记录文件名；
2. 回到工作列表，再新增一条记录（制造差异）；
3. 「导入 / 还原备份」，选「替换 / 还原」，选中刚才导出的文件；
4. 确认预览显示正确的条数，执行「完整还原」；
5. 确认第 2 步新增的那条记录消失了，第 1 步时的数据回来了。

---

## 第 13 步 · 报表导出

1. 台账 →「导出 XLSX」，确认下载成功；
2. 报告 →「导出 Word」，确认下载成功；
3. 如果机器上装了办公套件（WPS / 永中等），把两个文件各打开一次。

打不开或排版异常，属于**文档兼容性**问题，和应用的数据完整性是两回事，请分开记录。

---

## 第 14 步 · 离线确认

这台机器本来就不联网。确认整个流程没有任何一步需要联网。

打开开发者工具 → Network，刷新页面，确认所有请求都指向 `127.0.0.1:8765`。
浏览器自己的后台请求（升级检查、安全服务等）与本应用无关，如果看到，请单独记下来，不要算作
CivicWorkDesk 的联网行为。

---

## 第 15 步 · 性能主观观察（因为浏览器禁用了 GPU 合成）

这台机器的浏览器启动参数里有 `--disable-gpu-compositing`，所以滚动和动画都走 CPU。
请主观评价（流畅 / 可接受 / 卡顿），不需要量化：

- 工作列表上下滚动；
- 台账左右、上下滚动，表头是否跟随；
- 打开 / 关闭对话框；
- 展开一条内容较多的记录；
- 生成报告；
- 改变窗口大小。

**没有测到问题就不要提性能要求**——不卡就是不卡，不需要为此做优化。

---

## 第 16 步 · 收集结果

```sh
sh scripts/collect-results.sh
```

打开生成的结果文件确认内容，然后回传。**发送前请自己看一遍**：不要包含浏览器配置目录、
个人下载文件或真实业务数据。

---

## 需要回传的内容

1. `civic-work-desk-uos-rc1-results-<时间>.txt`（上一步生成的）；
2. 填好的 `acceptance/RESULT_TEMPLATE.md`（如果没有直接在原文件上填写）；
3. `.runtime/headers-*.txt`（响应头抓取，如果 collect 脚本没有自动包含）；
4. 如果出现白屏或报错：浏览器控制台的截图或文本。
