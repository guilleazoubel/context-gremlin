import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { testFileSystemContract } from '../support/file-system-contract';

testFileSystemContract(
  'InMemoryFileSystem',
  async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/mem', { recursive: true });
    return fs;
  },
  (...segments) => `/mem/${segments.join('/')}`,
);
