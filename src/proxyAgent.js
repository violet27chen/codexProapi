import { ProxyAgent } from 'undici';

const proxyAgents = new Map();

/**
 * 获取缓存的 ProxyAgent 实例
 * @param {string} proxyUrl - 代理 URL，例如 http://127.0.0.1:7890
 * @returns {ProxyAgent|undefined}
 */
export function getProxyAgent(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string' || !proxyUrl.trim()) return undefined;
  const url = proxyUrl.trim();
  let agent = proxyAgents.get(url);
  if (!agent) {
    try {
      agent = new ProxyAgent(url);
      proxyAgents.set(url, agent);
    } catch (e) {
      console.error(`[ProxyAgent] 代理 URL 格式错误: ${url}`, e.message);
      return undefined;
    }
  }
  return agent;
}
