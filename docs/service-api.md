# 收件服务接口

人工资料接收保持兼容。POST /intakes 的 JSON 字段为 collectionId、sourceKey、revision、mediaType、contentBase64；返回 receiptId、sha256、byteLength 和轻量 summary。相同资料集、来源键与修订对应同一收件，字节不同返回 409。GET /receipts/{receiptId} 可读元数据，GET /receipts/{receiptId}/body 返回原字节。

POST /acquisitions 接受 collectionId、entry 和可选 options，entry 是授权来源完整地址。若入口是多语种目录（含 data-language 入口链接），服务会领取入口表并逐一领取各语言入口，手动跟随同源跳转，为入口表、每个落地页（含跳转落地字节）登记真实收件，并写入结构化解释；非目录入口仍只领取原始内容。返回 collectionId 和全部 receiptIds。自动取得的依赖同样保留真实原文收件，不用人工造 records 代替自动接入。来源访问只限启动时冻结的 origin，不能访问其他主机或执行交付件；同源跳转最多五跳，成环或越界按来源错误拒绝。

GET /collections 返回资料集列表，GET /collections/{collectionId} 返回 collectionId、receipts、records、issues。结构化 records 的每项包含 kind、key、value、provenance；key 由各来源身份语义决定，不要求特定内部编码。多语种目录自动写入以下种类：

- language-observation：键为产品加请求语言。value 含 product、requestedLanguage、actualLanguage、state（confirmed/fallback/unresolved）、region、canonical、alternates、redirected、requestedUrl、finalUrl、hops。canonical 只是页面声明，不参与键或跨语言合并。
- product-body：键为产品加实际语言，value 保留 actualLanguage、region 与正文文本；回退页的英文正文只登记为英文。
- language-observation-history、product-body-history：补译或来源变化导致当前记录被替换时的归档，带 supersededAt，原 provenance 保留；来源未变化的重跑不产生历史。

provenance 是含 receiptId 与 location 的数组，location 可采用字节区间、原行列、JSON Pointer、redirect:hopN: 跳转位置等可复查定位。issues 每项包含 reason、location，至少能说明原因、受影响范围和已有来源依据，不能用静默丢弃表示未知。语言信号冲突记 language_signal_conflict，入口无法领取记 entry_unverified，缺少正文身份记 missing_product_identity；缺失资料不等于来源明确删除。

POST /collections/{collectionId}/records 可录入人工确认记录，必须附本资料集的真实收件出处。自动接入不能依赖操作者事先写入答案。该接口目前采用同键不可变约定；新增版本、历史记录与当前视图如何协调，应与来源语义相符，不能覆盖已归档原文。来源契约中的值是查询视图契约，不限定解析器、状态机或索引的内部实现。

本地 provider 是独立 HTTP 来源，fixtures 为合成的公开样本，不包含真实个人或机构凭据。fixtures/descriptor.json 说明来源入口与接入选项。多数资料源用 /deliveries 声明 deliveryId、revision、roots 和 resources；roots 是需处理的独立入口，resources 是同包可领取资源，不是公网搜索指令。文件可用 GET、HEAD 与单段 Range 读取；ETag 表示返回字节的身份。SOURCE_STAGE=partial 启动不完整交付状态，完整状态是默认值。来源服务不接受写操作。
