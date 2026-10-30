import 'react'

// NOTE: this is needed to get styled jsx components to work without explicitly importing & setting up the package in the UI component. This is because these UI components will be imported into the web app anyways which has the right package setup under nextjs.
declare module 'react' {
  interface StyleHTMLAttributes<T> extends HTMLAttributes<T> {
    jsx?: boolean
    global?: boolean
  }
}

declare module '*.css' {}

declare module 'react-image-crop/dist/ReactCrop.css' {}
