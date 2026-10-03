import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { ApolloClient, createHttpLink, InMemoryCache } from '@apollo/client/core'
import { DefaultApolloClient } from '@vue/apollo-composable'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import App from './App.vue'
import { router } from './router'
import { apolloClient } from './graphql/client'
import { bootSync } from './stores/sync'
import './styles.css'

const vuetify = createVuetify({ components, directives, theme: { defaultTheme: 'light', themes: { light: { colors: { primary: '#315b72', secondary: '#8c6a2f', surface: '#ffffff', background: '#edf1f2' } } } } })
void ApolloClient
void createHttpLink
void InMemoryCache

const app = createApp(App)
app.provide(DefaultApolloClient, apolloClient)
app.use(createPinia())
app.use(router)
app.use(vuetify)
// Pinia 就绪后启动离线回传调度（监听网络恢复、重启自动补发）
bootSync()
app.mount('#app')
