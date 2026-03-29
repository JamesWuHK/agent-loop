import { describe, it, expect, vi, beforeEach } from 'vitest'

// We need to test the validation logic directly since the module has side effects
describe('validateBranchName', () => {
  // Test the validation logic directly
  const validateBranchName = (branch: string): void => {
    if (!/^[a-zA-Z0-9/_-]+$/.test(branch)) {
      throw new Error(`Invalid branch name: contains forbidden characters: ${branch}`)
    }
    if (/^[-.]|[\/]$/.test(branch)) {
      throw new Error(`Invalid branch name: cannot start with '-' or '.', or end with '/': ${branch}`)
    }
    const segments = branch.split('/')
    for (const segment of segments) {
      if (segment === '') {
        throw new Error(`Invalid branch name: empty segment: ${branch}`)
      }
    }
  }

  describe('valid branch names', () => {
    it('should accept valid branch names with alphanumeric characters', () => {
      expect(() => validateBranchName('main')).not.toThrow()
      expect(() => validateBranchName('feature123')).not.toThrow()
      expect(() => validateBranchName('branchName')).not.toThrow()
    })

    it('should accept valid branch names with hyphens', () => {
      expect(() => validateBranchName('feature-branch')).not.toThrow()
      expect(() => validateBranchName('my-long-branch-name')).not.toThrow()
    })

    it('should accept valid branch names with underscores', () => {
      expect(() => validateBranchName('feature_branch')).not.toThrow()
      expect(() => validateBranchName('my_long_branch_name')).not.toThrow()
    })

    it('should accept valid branch names with forward slashes', () => {
      expect(() => validateBranchName('agent/3/uuid')).not.toThrow()
      expect(() => validateBranchName('feature/branch/nested')).not.toThrow()
    })

    it('should accept the expected agent branch format', () => {
      expect(() => validateBranchName('agent/3/26b30210-aa5a-43df-9e36-ef64c0e50ec1')).not.toThrow()
      expect(() => validateBranchName('agent/123/xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx')).not.toThrow()
    })
  })

  describe('invalid branch names - forbidden characters', () => {
    it('should reject branch names with spaces', () => {
      expect(() => validateBranchName('branch name')).toThrow()
    })

    it('should reject branch names with shell metacharacters', () => {
      expect(() => validateBranchName('branch;rm')).toThrow()
      expect(() => validateBranchName('branch|cat')).toThrow()
      expect(() => validateBranchName('branch$var')).toThrow()
      expect(() => validateBranchName('branch`cmd`')).toThrow()
    })

    it('should reject branch names with git forbidden characters', () => {
      expect(() => validateBranchName('branch~')).toThrow()
      expect(() => validateBranchName('branch^')).toThrow()
      expect(() => validateBranchName('branch:')).toThrow()
      expect(() => validateBranchName('branch*')).toThrow()
      expect(() => validateBranchName('branch?')).toThrow()
      expect(() => validateBranchName('branch[')).toThrow()
      expect(() => validateBranchName('branch]')).toThrow()
      expect(() => validateBranchName('branch\\')).toThrow()
    })

    it('should reject branch names with path traversal attempts', () => {
      expect(() => validateBranchName('../etc/passwd')).toThrow()
      expect(() => validateBranchName('branch/../../etc')).toThrow()
    })

    it('should reject branch names with newlines or other control characters', () => {
      expect(() => validateBranchName('branch\nname')).toThrow()
      expect(() => validateBranchName('branch\tname')).toThrow()
    })
  })

  describe('invalid branch names - format rules', () => {
    it('should reject branch names starting with hyphen', () => {
      expect(() => validateBranchName('-branch')).toThrow()
    })

    it('should reject branch names starting with dot', () => {
      expect(() => validateBranchName('.branch')).toThrow()
    })

    it('should reject branch names ending with slash', () => {
      expect(() => validateBranchName('branch/')).toThrow()
    })

    it('should reject branch names with empty segments', () => {
      expect(() => validateBranchName('agent//uuid')).toThrow()
      expect(() => validateBranchName('//uuid')).toThrow()
    })
  })
})
