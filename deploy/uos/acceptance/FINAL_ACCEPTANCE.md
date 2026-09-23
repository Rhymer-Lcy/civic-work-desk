# 最终安装形态 — 目标机验收手册

> 这一轮验收的对象是**最终安装形态**，不是 RC1.1 的候选测试包。
> RC1.1 已经验证过「BusyBox 能不能正确提供这个应用」；这一轮验证的是
> 「装好之后，从菜单点开、日常使用、升级、回退、卸载，是不是都对」。
>
> **在结果表里，没做的项目请写 N/A，不要写 PASS。** 没测到的事实比错误的结论便宜得多。

## 零、准备

需要两个文件：

- `civic-work-desk-uos20-loongarch64-<版本>.tar.gz`（安装包）
- `civic-work-desk-uos20-loongarch64-<版本>.tar.gz.sha256`（校验值）

以及本包（验收工具）：`civic-work-desk-uos20-final-acceptance-<版本>.tar.gz`

**测试全程只使用编造的假数据。** 不要录入任何真实的人名、单位、事由或文号。
导出的报表与备份在测试结束后请自行删除。

## 一、校验安装包（第 1 项）

```sh
cd <安装包所在目录>
sha256sum -c civic-work-desk-uos20-loongarch64-<版本>.tar.gz.sha256
```

必须显示 `OK`。不是 `OK` 就停下，不要安装。把实际输出抄进结果表。

## 二、安装（第 2 项）

```sh
tar -xzf civic-work-desk-uos20-loongarch64-<版本>.tar.gz
cd civic-work-desk-uos20-loongarch64-<版本>
sh install.sh
```

要确认的三件事：

1. **全程没有提示输入密码**，也没有出现 `sudo`；
2. 最后显示「安装完成」和「检查通过」；
3. 记录它打印的安装路径。

## 三、从菜单启动（第 3、4 项）

1. 打开开始菜单，找到「**政务工作记录台**」，点开。
2. 记录：是否有图标、是否打开了 **360 安全浏览器**、地址栏是否**逐字**是
   `http://127.0.0.1:8765/`。
3. **再点一次菜单项**（重复启动）。应当只是切换到已打开的页面或再开一个标签页，
   **不应**出现报错，也不应启动第二个服务。用下面的命令确认服务只有一个：

```sh
civic-work-desk-status
```

记录它报告的 PID。第二次点击前后，PID 应当**相同**。

## 四、浏览器平台证据（第 5 项）— 这一轮必须补上

在打开的页面上按 `F12` 打开开发者工具，切到 **Console**，把下面这段整体粘贴进去，回车：

```js
(async () => {
  const r = await navigator.serviceWorker.getRegistrations();
  const k = await caches.keys();
  console.log(
    JSON.stringify(
      {
        origin: location.origin,
        indexedDB: 'indexedDB' in window,
        serviceWorker: 'serviceWorker' in navigator,
        caches: 'caches' in window,
        subtle: typeof crypto.subtle,
        randomUUID: typeof crypto.randomUUID,
        swRegistrations: r.length,
        cacheKeys: k,
      },
      null,
      2,
    ),
  );
})();
```

把输出的 JSON **原样**抄进结果表。同时记录 Console 里**有没有红色报错**（有的话把文字抄下来）。

> 这段代码只读取浏览器能力，不读取也不导出任何业务数据。
> 它是为这次验收临时粘贴的，应用本身没有为此增加任何代码。

## 五、核心流程（第 6 项）

用**假数据**走一遍：

1. 新建一条工作记录；
2. 编辑它；
3. 加一条进展；
4. 新建一个荣誉，并关联到那条工作记录；
5. 用搜索/筛选找到它；
6. 打开台账页；
7. 打开报表预览。

每一步记录 PASS / FAIL。FAIL 的话记录页面提示和 Console 里的报错。

## 六、持久化（第 7 项）

按顺序做，每一步之后都回到页面确认刚才那条记录还在：

1. **刷新页面**（F5）；
2. **完全关闭 360 浏览器再重新打开**（从菜单启动应用）；
3. **停止再启动本地服务**：

```sh
civic-work-desk-stop
civic-work-desk-status      # 应报告未运行
civic-work-desk             # 重新启动并打开
```

4. **重启整台工作站**，登录后从菜单打开应用，确认记录还在，且地址仍然是
   `http://127.0.0.1:8765/`。

> 第 4 步如果这次没做，结果表里写 **N/A**，不要写 PASS。
> 这一项和上一轮一样是未闭合项，它是 Phase 3 收尾的前置条件之一。

## 七、备份与恢复（第 8 项）

1. 「设置 → 数据与备份 → 导出 JSON 备份」，记录文件落在哪个目录；
2. 故意改动数据（删掉一条、改掉一条）；
3. 用刚才那个文件恢复；
4. 确认恢复后的内容与导出时**完全一致**。

## 八、报表（第 9 项）

1. 导出 XLSX，用本机的表格软件打开，确认能打开且内容正常；
2. 导出 DOCX，用本机的文档软件打开，确认能打开且内容正常。

## 九、离线（第 10 项）

断开网络（拔网线或关掉无线），重复第五节的核心流程。应当全部正常。

## 十、端口冲突（第 11 项）— 请用附带的脚本，不要手工造冲突

```sh
sh scripts/port-conflict-test.sh
```

这个脚本**自己**启动一个临时占位进程占住 8765，然后调用启动器，最后**只**结束它自己
启动的那个进程。要确认的是启动器的四个行为：

1. 明确报出端口被占用；
2. **没有**结束占用端口的进程（脚本会在之后验证占位进程仍然存活）；
3. **没有**改用别的端口；
4. **没有**打开浏览器。

脚本最后会打印 `RESULT: PASS` 或 `RESULT: FAIL`。把整段输出保留下来。

## 十一、升级与回退（第 12 项）

只有在同时收到**两个**版本的安装包时才做这一项；只收到一个就写 N/A。

1. 先按上面的步骤录入几条假数据；
2. 解压新版本，`sh install.sh`；
3. 确认：`civic-work-desk-status` 显示新版本号，**而刚才录入的假数据仍在**；
4. 确认地址仍然是 `http://127.0.0.1:8765/`；
5. `civic-work-desk-rollback`，确认切回旧版本，数据仍在。

## 十二、状态与停止命令（第 13 项）

```sh
civic-work-desk-status
civic-work-desk-stop
civic-work-desk-status
```

确认输出是中文、能看懂，并且第二次 status 正确地说「未运行」。

## 十三、卸载（第 14 项）— 放在最后做

```sh
civic-work-desk-uninstall
```

确认：

1. 菜单项消失；
2. 程序目录被删除；
3. 最后明确提示**浏览器里仍然保留着本应用的数据**；
4. 你导出的 JSON 备份、XLSX、DOCX **都还在下载目录里**。

如果还要继续使用，重新 `sh install.sh` 即可，原来的假数据会重新出现
（因为数据在浏览器里，不在程序目录里）。

## 十四、收集结果

```sh
sh scripts/collect-results.sh
```

它会生成一个 `civic-work-desk-final-results-<时间>.txt`，内容只包括：
状态输出、版本信息、部署日志、服务日志、菜单项内容、以及安装目录的文件清单。

**它不会**读取浏览器配置、浏览历史、Cookie、下载的文件，也不会列出你的主目录。

把这个文件、填好的 `RESULT_TEMPLATE.md`、以及第四节 Console 输出的那段 JSON 一起回传。

## 附：关于服务日志的一个说明（请不要据此判 FAIL）

BusyBox httpd 在不加 `-v` 的情况下**不记录请求行**，所以 `httpd.log` 正常情况下应当是**空的**。

**空日志不是故障。** 它恰好是我们想要的：不记录访问路径。
判断服务是否正常，看 `civic-work-desk-status` 的健康检查结果，不要看日志里有没有内容。

（上一轮 RC1.1 手册里写着「日志里必须能看到原始路径」，那句话对 BusyBox 是不成立的，会导致
误判为 FAIL。本轮已更正。）
