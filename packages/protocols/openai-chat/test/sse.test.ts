import { describe, expect, it } from 'vitest';
import { SseParser, formatSse } from '@openferry/protocol-openai-chat';

describe('SseParser', () => {
  it('parses a single event', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\n\n')).toEqual([{ data: '{"a":1}' }]);
  });

  it('reassembles an event split across chunks', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a')).toEqual([]);
    expect(parser.push('":1}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ data: '{"a":1}' }]);
  });

  it('parses multiple events in one chunk', () => {
    const parser = new SseParser();
    const events = parser.push('data: one\n\ndata: two\n\n');
    expect(events.map((e) => e.data)).toEqual(['one', 'two']);
  });

  it('handles CRLF line endings, including a split CRLF', () => {
    const parser = new SseParser();
    expect(parser.push('data: one\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual([{ data: 'one' }]);
  });

  it('ignores comment lines', () => {
    const parser = new SseParser();
    const events = parser.push(': keep-alive\n\ndata: x\n\n');
    expect(events).toEqual([{ data: 'x' }]);
  });

  it('joins multi-line data with newlines', () => {
    const parser = new SseParser();
    const events = parser.push('data: line1\ndata: line2\n\n');
    expect(events[0]?.data).toBe('line1\nline2');
  });

  it('carries the event name', () => {
    const parser = new SseParser();
    const events = parser.push('event: ping\ndata: {}\n\n');
    expect(events[0]?.event).toBe('ping');
  });

  it('dispatches a trailing event without a blank line at EOF', () => {
    const parser = new SseParser();
    parser.push('data: last');
    expect(parser.end()).toEqual([{ data: 'last' }]);
  });

  it('does not emit an empty event for a trailing blank line', () => {
    const parser = new SseParser();
    parser.push('data: a\n\n');
    expect(parser.end()).toEqual([]);
  });

  it('round-trips through formatSse', () => {
    const parser = new SseParser();
    const events = parser.push(formatSse('{"x":1}'));
    expect(events).toEqual([{ data: '{"x":1}' }]);
  });

  it('splits multi-line payloads back into one data value', () => {
    const parser = new SseParser();
    const events = parser.push(formatSse('a\nb'));
    expect(events[0]?.data).toBe('a\nb');
  });
});
