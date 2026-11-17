/** Errors that map to a clean JSON `{error}` response (Italian messages: they can reach the user). */
export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

/** 400 — invalid parameters. */
export class BadRequest extends HttpError {
  constructor(message: string) { super(400, message); }
}

/** 503 — static data (the GTFS database) not built yet. */
export class NotReady extends HttpError {
  constructor(message = 'Dati non ancora pronti: il server sta preparando le linee, riprova tra qualche minuto.') { super(503, message); }
}

/** 502 — an upstream feed (Cotral, ASTRAL, Roma Mobilità) failed and there is no usable cached copy. */
export class UpstreamError extends HttpError {
  constructor(message: string, public readonly upstreamStatus = 0) {
    super(502, `Servizio upstream non raggiungibile: ${message}`);
  }
}
