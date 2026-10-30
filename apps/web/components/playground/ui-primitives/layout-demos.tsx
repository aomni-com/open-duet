'use client'

import { GearIcon, HouseIcon, QuestionIcon, UserIcon } from '@phosphor-icons/react'
import React, { useState } from 'react'

import { Box } from '@repo/ui/components/common/box'
import {
  DescriptiveSidebar,
  type DescriptiveSidebarItem,
} from '@repo/ui/components/common/descriptive-sidebar'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@repo/ui/components/common/drawer'
import { Header } from '@repo/ui/components/common/header'
import { Button } from '@repo/ui/components/shadcn/button'

export function LayoutDemos() {
  const [isLoading, setIsLoading] = useState(false)
  const [selectedSidebarKey, setSelectedSidebarKey] = useState('home')

  const sidebarItems: DescriptiveSidebarItem[] = [
    {
      type: 'data',
      key: 'home',
      title: 'Home',
      description: 'Main dashboard view',
      icon: HouseIcon,
      onClick: () => setSelectedSidebarKey('home'),
    },
    {
      type: 'schema',
      key: 'settings',
      title: 'Settings',
      description: 'Application configuration',
      icon: GearIcon,
      count: 5,
      onClick: () => setSelectedSidebarKey('settings'),
    },
    {
      type: 'data',
      key: 'profile',
      title: 'Profile',
      description: 'User profile management',
      icon: UserIcon,
      onClick: () => setSelectedSidebarKey('profile'),
      disabled: true,
      tooltipLabel: 'Profile editing is currently disabled',
    },
    { type: 'divider', title: 'Divider' },
    {
      type: 'data',
      key: 'help',
      title: 'Help',
      description: 'Documentation and support',
      icon: QuestionIcon,
      href: '/help',
    },
  ]

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Box Component</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Box.Container className="max-w-md">
            <Box.Title
              icon={HouseIcon}
              text="Primary Box Title"
              loading={isLoading}
              renderRight={() => (
                <button
                  onClick={() => setIsLoading(!isLoading)}
                  className="text-sm text-blue-500 hover:underline"
                >
                  Toggle Loading
                </button>
              )}
            />
            <div className="mt-4 text-sm text-muted-foreground">
              This is a primary box with an icon and loading state. Click &quot;Toggle Loading&quot;
              to see the animated ellipsis.
            </div>
          </Box.Container>

          <Box.Container className="max-w-md">
            <Box.Title icon={GearIcon} text="Secondary Box Title" variant="secondary" />
            <div className="mt-4 text-sm text-muted-foreground">
              This is a secondary variant of the box component with different styling.
            </div>
          </Box.Container>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Header Component</h3>
        <div className="space-y-4">
          <Header
            title="Sample Header with Beta"
            icon={GearIcon}
            isBeta={true}
            hasBackButton={true}
            onBackClick={() => alert('Back clicked')}
            rightContent={<Button size="sm">Action Button</Button>}
          />

          <Header
            title="Header with Loading"
            icon={UserIcon}
            isLoading={true}
            variant="transparent-border"
          />
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Descriptive Sidebar</h3>
        <div className="max-w-md border rounded-lg">
          <DescriptiveSidebar items={sidebarItems} selectedKey={selectedSidebarKey} />
        </div>
        <div className="text-sm text-muted-foreground">
          Selected: <strong>{selectedSidebarKey}</strong>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Drawer Component</h3>
        <Drawer>
          <DrawerTrigger asChild>
            <Button variant="outline">Open Drawer</Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Sample Drawer</DrawerTitle>
              <DrawerDescription>
                This is a drawer component that slides up from the bottom of the screen.
              </DrawerDescription>
            </DrawerHeader>
            <div className="p-4">
              <p className="text-sm text-muted-foreground">
                Drawer content goes here. This component is useful for mobile-friendly modals and
                forms.
              </p>
            </div>
            <DrawerFooter>
              <DrawerClose asChild>
                <Button variant="outline">Close</Button>
              </DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </div>
    </div>
  )
}
