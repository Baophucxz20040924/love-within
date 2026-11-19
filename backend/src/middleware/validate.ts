import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, infer as ZodInfer } from 'zod';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validate request parts against zod schemas. On success the parsed values
 * replace req.body/query/params. On failure the ZodError bubbles to errorHandler.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      // Parse everything before publishing any part, so failures leave the request unchanged.
      const body = schemas.body ? schemas.body.parse(req.body) : undefined;
      const query = schemas.query ? schemas.query.parse(req.query) : undefined;
      const params = schemas.params ? schemas.params.parse(req.params) : undefined;
      if (schemas.body) req.body = body;
      if (schemas.query) req.query = query as Request['query'];
      if (schemas.params) req.params = params as Request['params'];
      next();
    } catch (err) {
      next(err);
    }
  };
}

export type Infer<T extends ZodTypeAny> = ZodInfer<T>;
