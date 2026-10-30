'use client'

import React, { useState } from 'react'

import { Autocomplete } from '@repo/ui/components/common/autocomplete'
import { AutoCompleteInput } from '@repo/ui/components/common/autocomplete-input'
import { TextareaAutosize } from '@repo/ui/components/common/textarea-autosize'

type SampleOption = {
  id: string
  name: string
  label?: string
}

type User = {
  id: string
  name: string
  email: string
}

export function FormControlsDemos() {
  const [selectedFieldId, setSelectedFieldId] = useState<string>('')
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [searchValue, setSearchValue] = useState('')
  const [textareaValue, setTextareaValue] = useState('Type here to see the textarea auto-resize...')

  const sampleFields: SampleOption[] = [
    { id: 'name', name: 'Full Name', label: "User's complete name" },
    { id: 'email', name: 'Email Address', label: 'Primary contact email' },
    { id: 'phone', name: 'Phone Number', label: 'Mobile or landline number' },
    { id: 'company', name: 'Company', label: 'Workspace name' },
    { id: 'title', name: 'Job Title', label: 'Professional position' },
  ]

  const sampleUsers: User[] = [
    { id: '1', name: 'John Doe', email: 'john@example.com' },
    { id: '2', name: 'Jane Smith', email: 'jane@example.com' },
    { id: '3', name: 'Bob Johnson', email: 'bob@example.com' },
    { id: '4', name: 'Alice Brown', email: 'alice@example.com' },
    { id: '5', name: 'Charlie Wilson', email: 'charlie@example.com' },
  ]

  const filteredUsers = sampleUsers.filter(
    user =>
      user.name.toLowerCase().includes(searchValue.toLowerCase()) ||
      user.email.toLowerCase().includes(searchValue.toLowerCase()),
  )

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Autocomplete</h3>
        <div className="max-w-md">
          <Autocomplete
            selectedFieldId={selectedFieldId}
            list={sampleFields}
            onChange={(key: string | undefined) => setSelectedFieldId(key || '')}
          />
        </div>
        <div className="text-sm text-muted-foreground">
          Selected field: <strong>{selectedFieldId || 'None'}</strong>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">AutoComplete Input</h3>
        <div className="max-w-md">
          <AutoCompleteInput<User>
            searchValue={searchValue}
            onSearchValueChange={setSearchValue}
            options={filteredUsers}
            getOptionLabel={(user: User) => user.name}
            getOptionValue={(user: User) => user.id}
            onSelectedValueChange={(user: User) => {
              setSelectedUser(user)
              setSearchValue('')
            }}
            placeholder="Search users..."
            emptySearchValueMessage="Start typing to search users"
            noMatchesMessage="No users found matching your search"
          />
        </div>
        <div className="text-sm text-muted-foreground">
          Selected user:{' '}
          <strong>{selectedUser ? `${selectedUser.name} (${selectedUser.email})` : 'None'}</strong>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Textarea Autosize</h3>
        <div className="max-w-md">
          <TextareaAutosize
            value={textareaValue}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setTextareaValue(e.target.value)
            }
            placeholder="Start typing to see auto-resize..."
            minHeight={60}
            maxHeight={200}
            className="w-full"
          />
        </div>
        <div className="text-sm text-muted-foreground">
          Character count: <strong>{textareaValue.length}</strong>
        </div>
      </div>
    </div>
  )
}
