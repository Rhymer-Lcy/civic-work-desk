# CivicWorkDesk — UOS RC1 目标验收包

这个包**不是正式发布版**。它的唯一用途，是在那台统信 UOS 工作站上把还没验证过的东西验证一遍，
然后据此决定正式版怎么做。

在真实数据进入应用之前完成这次验收，是整个 Phase 3 的前提。

## 这里面有什么

```
civic-work-desk-uos-rc1/
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
    probe-target.sh         只读环境探针
    verify-files.sh         文件完整性校验
    collect-results.sh      结果收集
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

在传输之后、运行之前，先确认文件没有损坏。整包的 SHA-256 由发送方另行告知；包内文件的
校验清单是 `SHA256SUMS.txt`：

```sh
cd civic-work-desk-uos-rc1
sh scripts/verify-files.sh
```

必须看到「结果：通过」。不通过就不要继续，重新传一次。

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
