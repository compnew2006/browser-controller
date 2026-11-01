import { describe, expect, it } from 'vitest';
import { validateRelease } from '../scripts/check-release.mjs';

function release() {
  return {
    tag: 'v1.2.3',
    tagType: 'tag',
    version: '1.2.3',
    manifestVersion: '1.2.3',
    serverVersion: '1.2.3',
    packageVersions: ['1.2.3'],
    parentVersion: '1.2.2',
    changelog: '# Changelog\n\n## 1.2.3\n\n- Fixed something.\n\n## 1.2.2\n',
  };
}

describe('release tag validation', () => {
  it('accepts an annotated tag with matching versions and nonempty notes', () => {
    expect(validateRelease(release())).toEqual([]);
  });

  it('rejects lightweight tags, mismatched versions and a tag on the wrong commit', () => {
    const errors = validateRelease({ ...release(), tagType: 'commit', manifestVersion: '1.2.2', parentVersion: '1.2.3' });
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/annotated/u),
      expect.stringMatching(/manifest/u),
      expect.stringMatching(/parent/u),
    ]));
  });

  it('rejects missing notes and mismatched registry package versions', () => {
    const errors = validateRelease({ ...release(), packageVersions: ['1.2.2'], changelog: '## 1.2.3\n\n## 1.2.2\n- Earlier\n' });
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/notes/u), expect.stringMatching(/package/u)]));
  });
});
