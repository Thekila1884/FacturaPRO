import { handleRequest } from '../server.mjs';

export default function vercelHandler(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const apiPath = url.pathname === '/api' ? url.searchParams.get('path') : null;
    if (apiPath) {
        url.searchParams.delete('path');
        url.pathname = `/api/${apiPath.replace(/^\/+/, '')}`;
        request.url = `${url.pathname}${url.search}`;
    }
    return handleRequest(request, response);
}
