import { describe, expect, it } from 'vitest';
import { isPrivateAddress, magnificTarget } from '../src/imaging-proxy.ts';

describe('image enhancements: forwarding to Magnific', () => {
  it('forwards only upscaler paths and picks the service by the key header', () => {
    expect(magnificTarget('v1/ai/image-upscaler', { 'x-magnific-api-key': 'k1' })).toEqual({ url: 'https://api.magnific.com/v1/ai/image-upscaler', header: 'x-magnific-api-key', key: 'k1' });
    expect(magnificTarget('v1/ai/image-upscaler-precision-v2/046b6c7f-0b8a-43b9', { 'x-freepik-api-key': 'k2' })?.url).toBe('https://api.freepik.com/v1/ai/image-upscaler-precision-v2/046b6c7f-0b8a-43b9');
    expect(magnificTarget('v1/ai/text-to-image', { 'x-magnific-api-key': 'k1' })).toBeNull();
    expect(magnificTarget('v1/ai/image-upscaler/../../admin', { 'x-magnific-api-key': 'k1' })).toBeNull();
    expect(magnificTarget('v1/ai/image-upscaler', {})).toBeNull();
  });

  it('blocks internal and service addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });
});
