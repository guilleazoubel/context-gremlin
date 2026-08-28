import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { testFileSystemContract } from '../support/file-system-contract';

testFileSystemContract(
  'InMemoryFileSystem',
  () => new InMemoryFileSystem(),
  (...segments) => `/mem/${segments.join('/')}`,
);
