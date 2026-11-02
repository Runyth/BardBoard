/**
  BardBoard - A DiscordJS bot soundboard
  Copyright (C) 2024 Giovanbattista Abbate

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const backendUrl = process.env.BACKEND_URL
    || `http://localhost:${process.env.BOT_PORT || '3001'}`;
  const search = new URL(request.url).search;
  const headers = new Headers();

  for (const name of ['cookie', 'content-type']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const upstream = await fetch(`${backendUrl}/upload-audio-batch${search}`, {
      method: 'POST',
      headers,
      body: request.body,
      duplex: 'half'
    });

    const responseHeaders = new Headers();
    for (const name of ['content-type', 'retry-after']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders
    });
  } catch (error) {
    console.error('Batch upload proxy failed:', error);
    return Response.json({ error: 'Upload failed' }, { status: 502 });
  }
}
