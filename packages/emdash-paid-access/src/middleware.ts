import { createPaidAccess, type PaidAccess } from './core.js';
import { createMiddleware, type MiddlewareConfig } from './handler.js';
import config from 'virtual:radius-emdash-paid-access/config';

let access: PaidAccess | undefined;
const paidAccess = (): PaidAccess => (access ??= createPaidAccess(config as MiddlewareConfig));

export const onRequest = createMiddleware(paidAccess, config as MiddlewareConfig);
