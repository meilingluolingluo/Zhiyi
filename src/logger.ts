/** 极简日志封装：可在测试环境静默，失败路径只记日志不抛出。 */

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export function createLogger(silent: boolean): Logger {
  if (silent) {
    return {
      info: (): void => undefined,
      warn: (): void => undefined,
      error: (): void => undefined,
      debug: (): void => undefined,
    };
  }
  const prefix: string = '[memory-gateway]';
  return {
    info: (message: string, ...args: unknown[]): void =>
      console.log(prefix, message, ...args),
    warn: (message: string, ...args: unknown[]): void =>
      console.warn(prefix, message, ...args),
    error: (message: string, ...args: unknown[]): void =>
      console.error(prefix, message, ...args),
    debug: (message: string, ...args: unknown[]): void =>
      console.log(prefix, '[debug]', message, ...args),
  };
}
