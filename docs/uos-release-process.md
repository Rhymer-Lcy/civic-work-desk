# UOS 发布流程

> **状态：Stage B。** 服务方案已选定（BusyBox httpd，依据 RC1.1 目标机实测），正式发布包的流程
> 已可执行，见第五节。第二节的 RC 流程保留下来，因为它仍是「候选方案在目标机上能不能用」这一类
> 问题的答案来源。
>
> 仍未完成的是**最终安装形态的目标机验收**，因此任何发布包的 `VERSION` 里 `targetTested` 依旧
> 必须是 `NO`。

## 角色与机器

|      | 机器                  | 需要什么         |
| ---- | --------------------- | ---------------- |
| 构建 | 开发工作站（Windows） | Node 24 / npm 11 |
| 验收 | 目标 UOS 工作站       | 什么都不用装     |
| 使用 | 同上                  | 同上             |

Node 与 npm **只存在于构建机**。产物是静态文件。

## 一、构建

```sh
npm ci
npm run review:package    # 跑全部质量闸门并生成工程评审包
```

`review:package` 内含 `npm run build`，所以 `dist/` 一定与本次闸门运行一致。
**不要**手工跑 `npm run build` 之后直接打包——E2E 套件不会重新构建，很容易对着旧产物做判断。

## 二、组装 RC1 验收包

```sh
sh scripts/uos/build-rc1.sh        # 待 Stage B：正式版用 build-release.sh
```

它做四件事：把 `dist/` 复制进 `release/uos-rc1/app/`、写入 `deployment-health.json`（含应用 commit）、
写 `VERSION`、生成 `SHA256SUMS.txt`。

生成后必须自检一次：

```sh
cd release/uos-rc1 && sh scripts/verify-files.sh
node scripts/uos/lint-shell.mjs
```

后者检查的是这套部署自己的不变量：规范地址逐字一致、不需要 sudo、不按端口杀进程、
POSIX shell 无 bash 语法、Python 不用 3.8+ 语法。

## 三、传输

打成 `.tar.gz` 传到目标机。**是否用 tar/gzip 交付，取决于探针确认目标机有这两个工具**——
RC1 的探针会报告它们是否存在。整包的 SHA-256 单独告知接收方，包内文件的清单在 `SHA256SUMS.txt`。

## 四、验收（在目标机上）

见 `docs/uos-target-acceptance.md` 与包内 `acceptance/TARGET_ACCEPTANCE.md`。

## 五、正式发布包（Stage B，可执行）

源文件在 `deploy/uos/`（维护的那一份），产物在 `release/`。一条命令：

```sh
sh scripts/uos/build-release.sh          # 版本号默认取 UTC+8 的当天日期，如 2026.09.23-1
sh scripts/uos/build-release.sh 2026.10.05-1   # 或显式指定
```

日期用 `TZ=UTC-8` 取，不用机器本地时间——这台构建机跑在美东时区，直接 `date` 会写成前一天。

它产出**两个**包，这是有意的：

| 包                                                     | 内容                                                   |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `civic-work-desk-uos20-loongarch64-<版本>.tar.gz`      | 最终用户要的：`app/`、`runtime/`、`install.sh`、README |
| `civic-work-desk-uos20-final-acceptance-<版本>.tar.gz` | 测试人要的：验收手册、结果表、收集脚本、端口冲突脚本   |

各带一个 `.sha256`。验收材料单独成包，用户包里就不会混进评审用的东西；而测试人两个都要，所以
一起发。用户包里**没有**源码、测试、sourcemap、两个候选方案、Python 服务，也没有验收手册。

打包前后各有一道自检，顺序是刻意的：

1. **打包之前**，`verify-app-unchanged.mjs` 把 `app/` 与 `dist/` 逐文件比哈希。Phase 3 交付的是
   未改动的 Phase-2 构建，唯一允许的差异是多一个 `deployment-health.json`（部署产物，写在构建
   旁边而不是写进构建里）。不过就不打包；
2. **打包之后**，`npm run test:uos:archive` 解析 tar 的字节：所有权元数据是否归零（不带开发机
   账号名）、`install.sh` 的可执行位、成员清单、内层清单是否与实际内容逐一对得上、`app/` 是否与
   `dist/` 逐字节一致、地址是否处处规范、`targetTested` 是否还是 `NO`、以及
   `docs/uos-final-acceptance.md` 里写的那个 SHA-256 是否就是这个包的。

最后一条是防「陈旧的伴生文件」：文档里手抄的哈希会在重新打包的那一刻过期，而它正是回传证据要
对照的值。

## 六、部署自身的闸门

应用的闸门照旧（`npm run review:package`）。部署这一层另有三道：

```sh
npm run verify:uos        # = lint:uos + test:uos + test:uos:archive
```

- `lint:uos`：规范地址逐字一致、不需要 sudo、不按端口杀进程、POSIX shell 无 bashism、
  Python 不用 3.8+ 语法。**新增一个发布包目录时，必须把它加进 `lint-shell.mjs` 的 `ROOTS`**——
  这不是整洁问题：`release/uos-rc1` 并不包含 `release/uos-rc1-1`，RC1.1 就因此有 12 个文件一直
  在扫描范围之外，而闸门照样报 PASS；
- `test:uos`：在 POSIX 主机（本机用 WSL2）上跑真实的 BusyBox、真实的 `/proc`、真实的信号，
  138 条断言覆盖安装、幂等启动、进程归属、陈旧 PID、端口冲突、健康不一致、升级、回退、卸载保留、
  三种「最简环境」（无 setsid、逐一只留一种 HTTP 客户端）、**安装故障注入**（坏包、暂存失败、
  副本校验失败、切指针失败、续做、同版本、拒绝 --force、菜单项失败）、**强杀前的 PID 复用**，
  以及**启动锁的五种被遗弃形态**。数字以套件自己的输出为准，不以本文为准。
  **没有 POSIX 主机时它报错退出，不静默跳过**；确实要跳过得显式写 `CIVIC_UOS_TESTS=skip`；
- `test:uos:archive`：上一节那 55 项，覆盖**两个**交付包（安装包与验收包），并核对验收手册里
  「先收证据、后卸载」的顺序——检查的是**包里那一份**，不是源码树里那一份。

## 七、发布元数据

每个发布包的 `VERSION` 至少记录：`releaseId`、应用版本、应用 commit、规范地址、选定的服务方案、
`pythonRequired=NO`、`sudoRequired=NO`、构建时间、验证过的目标机指纹、以及 `targetTested`。

`targetTested` 在**最终安装形态**通过目标机验收之前**必须**写 `NO`。这不是待办事项的占位符，
它是关于这个产物的一句事实。
