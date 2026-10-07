import {toUrlMatchers} from './url-match';

describe('toUrlMatchers', () => {
  it('turns a string into a prefix matcher', () => {
    const [matcher] = toUrlMatchers(['https://api.test/api/']);
    expect(matcher.test('https://api.test/api/Currency/picker?x=1')).toBeTrue();
  });

  it('does not match other hosts or paths', () => {
    const [matcher] = toUrlMatchers(['https://api.test/api/']);
    expect(matcher.test('https://other.test/api/x')).toBeFalse();
    expect(matcher.test('https://api.test/other/x')).toBeFalse();
    expect(matcher.test('https://evil.com/?u=https://api.test/api/')).toBeFalse();
  });

  it('escapes regular expression characters in the string', () => {
    const [matcher] = toUrlMatchers(['https://api.test/a+b/']);
    expect(matcher.test('https://api.test/a+b/x')).toBeTrue();
    expect(matcher.test('https://api.test/aab/x')).toBeFalse();
    expect(matcher.test('https://apixtest/a+b/x')).toBeFalse();
  });

  it('passes RegExps through unchanged', () => {
    const regex = /^https:\/\/api\.test\//;
    expect(toUrlMatchers([regex])[0]).toBe(regex);
  });

  it('returns an empty list for no entries', () => {
    expect(toUrlMatchers()).toEqual([]);
  });
});
