# Broker transport

宿主共用 JSON-lines Unix socket 传输：参数对象校验、请求和结果大小上限、连接超时、0600 socket、连接关闭/服务关闭取消和资源回收。调用者持有业务错误分类；网关仅返回稳定 code，不暴露内部异常。Web Research 保留自己的预算、来源台账、错误文案和格式化逻辑。
