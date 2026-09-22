# CivicWorkDesk — UOS RC1.1 目标验收包

这个包**不是正式发布版**。它的唯一用途，是在那台统信 UOS 工作站上把还没验证过的东西验证一遍，
然后据此决定正式版怎么做。

在真实数据进入应用之前完成这次验收，是整个 Phase 3 的前提。

## 这里面有什么

```
civic-work-desk-uos-rc1-1/
  app/                      已构建的应用（与 Phase 2 验收版完全相同，未做任何改动）
    deployment-health.json    部署健康探针（不含任何个人信息）
  candidate/
    busybox/                候选方案 A：BusyBox httpd（首选，因为目标机已有）
      start-test.sh
      stop-test.sh
      httpd.conf
    python/                 候选方案 B：Python 标准库静态服务（备选）
      server.py
  scripts/
    probe-target.sh           只读环境探针
    verify-files.sh           包内文件完整性校验
    capture-http-evidence.sh  抓取响应头与路径遍历探测（自动识别入口 JS/CSS）
    raw-path-probe.py         原样发送请求行的探测工具（仅标准库，仅验收用）
    collect-results.sh        结果收集
  acceptance/
    TARGET_ACCEPTANCE.md    ← 从这里开始，按步骤做
    RESULT_TEMPLATE.md      ← 边做边填
  SHA256SUMS.txt
  VERSION
  README-UOS-RC1.md（本文件）
```

不含源代码、不含 node_modules、不含开发工具、不含任何真实数据。
**目标机上不需要安装 Node、npm、nginx 或任何软件包。**

## 1. 先校验这个包

两道校验，管的是不同的事。**外层**确认压缩包传输完整，**内层**确认解压出来的每个文件与清单一致。

```sh
# 1a 解压前
sha256sum -c civic-work-desk-uos-rc1-1.tar.gz.sha256

# 1b 解压后
tar -xzf civic-work-desk-uos-rc1-1.tar.gz
cd uos-rc1-1
sh scripts/verify-files.sh
```

1a 期望 `OK`，1b 期望「结果：通过」。任何一道不通过都不要继续，重新传一次。

## 2. 然后按验收手册做

```sh
less acceptance/TARGET_ACCEPTANCE.md
```

手册里有十六步，每一步都写明了「期望看到什么」和「不对的时候怎么办」。

三条贯穿全程的规矩：

- **不需要 sudo。** 任何一步要密码，说明哪里不对，请停下来记录。
- **只用测试数据。** 不要导入真实工作记录。
- **地址必须是 `http://127.0.0.1:8765/`。** 不是 `localhost:8765`，不是别的端口。
  浏览器按「来源」隔离本地数据，换了来源，之前存的东西会看起来消失——这不是故障，
  但很容易被当成故障。

## 3. 做完之后

```sh
sh scripts/collect-results.sh
```

它会把探针报告、结果表和服务日志合并成一个文本文件。**发送之前请自己打开看一遍**，
确认里面没有浏览器配置、个人文档或真实业务数据。

## RC1.1 相对 RC1 改了什么

**应用没有任何改动**——`app/` 下的文件与 RC1、与 Phase-2 构建逐字节相同，这一点由
`scripts/uos/verify-app-unchanged.mjs` 自动比对并记录。改的只有验收工装：

1. **路径遍历探测原来测不到东西。** RC1 用的 `curl .../../SHA256SUMS.txt` 会被 curl 在发送前
   规范化成 `/SHA256SUMS.txt`，返回 404 只是因为该文件本就不在文档根目录里。现在改用
   `--path-as-is`（或标准库 Python 直接写请求行），并增加了 `%2e%2e` 与 `..%2f` 两种编码形式，
   每条都带响应体断言。
2. **CSS 的响应头原来根本没抓。** 结果表要求填 CSS 的 Content-Type，而命令块里没有请求 CSS。
   现在由脚本自动识别真实入口 JS 与 CSS 文件名并一并抓取，不需要手工替换文件名。
3. **Python 候选是前台运行的**，原来没有说明，测试者容易以为卡死。现在明确写了「开第二个终端」
   的完整做法。
4. **增加了外层压缩包校验**（`.sha256` 旁挂文件），与包内清单互补。
5. 压缩包不再携带开发机的用户名与 UID/GID。
6. 修正了停止脚本注释与实现不一致的地方（等待上限是 10 秒，不是 2 秒）。

## 这次验收要回答的问题

RC1 存在的原因，是下面这些问题目前**没有答案**，而且只能在那台机器上得到答案：

1. BusyBox 的 `httpd` 小程序在这台机器上编译进了哪些功能？特别是它给 `.js` 返回什么
   `Content-Type`——Chromium 会拒绝以非 JavaScript 类型返回的模块脚本，表现为白屏。
2. 它接不接受 `-c` 配置文件参数？如果不接受，MIME 类型就没法用配置修正。
3. `xdg-open` 打开的是不是 360 浏览器？
4. 端口 8765 是不是空闲的？
5. 在这台 CPU 上、在禁用 GPU 合成的浏览器里，台账滚动和对话框是否流畅？
6. Service Worker、Cache Storage、`crypto.subtle` 在这个浏览器版本上是否都可用？

这些问题回答之前，**不会**选定服务方案，**不会**安装桌面图标，也**不会**声称本产品兼容 UOS。

## 关于数据的一句话

CivicWorkDesk 的业务数据保存在**浏览器**里（IndexedDB），不在这个目录里。

- 复制或删除这个目录，都不会备份或删除业务数据；
- 唯一可移植的备份是应用内「导出 JSON 备份」生成的文件；
- 重装浏览器、重置浏览器配置、换浏览器或换地址，都可能让已有数据看起来消失。

验收阶段用的是测试数据，所以这次不涉及。等到真实使用时，这一条会写在正式部署文档的最前面。
