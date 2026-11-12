/** 统一的 OpenAI 风格错误响应体，供路由层与代理层共用。 */
export interface ErrorEnvelope {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

export function errorBody(
  message: string,
  code: string,
  type = 'invalid_request_error',
): ErrorEnvelope {
  return { error: { message, type, code } };
}
