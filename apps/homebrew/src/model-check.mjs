/** Only the operator-entered DeepSeek credential is sent to this fixed vendor endpoint. */
export async function checkModel(apiKey, fetcher = fetch) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw Error('请输入有效的 API Key');
  let response;
  try { response = await fetcher('https://api.deepseek.com/models', { headers: { authorization: `Bearer ${apiKey.trim()}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw Error('无法连接 DeepSeek，请检查网络后重试'); }
  if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? '模型服务拒绝了此 API Key，请检查账号配置' : '模型服务暂时不可用，请稍后重试');
  const text = await response.text();
  if (text.length > 256_000) throw Error('模型服务返回数据过大');
  let data; try { data = JSON.parse(text); } catch { throw Error('模型服务返回格式无效'); }
  const models = [...new Set((Array.isArray(data.data) ? data.data : []).map(m => m?.id).filter(id => typeof id === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(id)))].slice(0, 100);
  if (!models.length) throw Error('账号没有返回可用模型');
  return models;
}
