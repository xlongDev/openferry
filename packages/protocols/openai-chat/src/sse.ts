/**
 * 增量 SSE 解析器。
 *
 * 必须覆盖的边界（见 docs/protocols/compatibility-matrix.md §3）：
 *  - 一个事件跨多个网络块
 *  - 多个事件合并在一个块
 *  - CRLF / LF 混用
 *  - 注释行（`:` 开头）
 *  - 流在没有结尾空行时结束
 *
 * 解析器只负责切事件，不解释 data 的内容 —— JSON 解析失败属于协议层，
 * 在那里可以转成 ProtocolError 而不是让进程崩掉。
 */

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export class SseParser {
  #buffer = '';
  #dataLines: string[] = [];
  #eventName: string | undefined;
  #id: string | undefined;

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    return this.#drain(false);
  }

  /** 流结束时调用：把残留的半行当作最后一行处理。 */
  end(): SseEvent[] {
    return this.#drain(true);
  }

  #drain(final: boolean): SseEvent[] {
    const out: SseEvent[] = [];
    let cursor = 0;

    for (;;) {
      const newline = this.#buffer.indexOf('\n', cursor);
      if (newline === -1) break;
      const line = this.#buffer.slice(cursor, newline);
      cursor = newline + 1;
      this.#consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line, out);
    }

    this.#buffer = this.#buffer.slice(cursor);

    if (final) {
      if (this.#buffer.length > 0) {
        const line = this.#buffer.endsWith('\r') ? this.#buffer.slice(0, -1) : this.#buffer;
        this.#buffer = '';
        this.#consumeLine(line, out);
      }
      // 上游常常省略结尾空行，宽容地派发最后一个事件。
      this.#dispatch(out);
    }

    return out;
  }

  #consumeLine(line: string, out: SseEvent[]): void {
    if (line.length === 0) {
      this.#dispatch(out);
      return;
    }
    if (line.startsWith(':')) return; // 注释 / keep-alive

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        this.#dataLines.push(value);
        break;
      case 'event':
        this.#eventName = value;
        break;
      case 'id':
        this.#id = value;
        break;
      default:
        // retry 等字段对本项目无意义，忽略。
        break;
    }
  }

  #dispatch(out: SseEvent[]): void {
    if (this.#dataLines.length > 0) {
      out.push({
        data: this.#dataLines.join('\n'),
        ...(this.#eventName === undefined ? {} : { event: this.#eventName }),
        ...(this.#id === undefined ? {} : { id: this.#id }),
      });
    }
    this.#dataLines = [];
    this.#eventName = undefined;
    this.#id = undefined;
  }
}

/** 编码一个 SSE 事件。data 内部若含换行，按规范拆成多行 data。 */
export function formatSse(data: string, event?: string): string {
  const lines = data.split('\n').map((line) => `data: ${line}`);
  const head = event === undefined ? '' : `event: ${event}\n`;
  return `${head}${lines.join('\n')}\n\n`;
}
