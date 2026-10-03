<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { useTrackStore } from './stores/track'

const route = useRoute()
const store = useTrackStore()
const title = computed(() => route.name === 'track' ? '区段里程与缺陷分布' : route.name === 'workOrders' ? '整治任务与复测' : route.name === 'sync' ? '离线回传与冲突复核' : route.name === 'audit' ? '整治审计' : '轨道缺陷总览')
</script>

<template>
  <v-app>
    <aside class="shell-nav">
      <div class="brand"><strong>轨</strong><div><b>轨道几何整治台</b><span>缺陷派工、复测与限速联查</span></div></div>
      <nav>
        <RouterLink to="/"><span>缺陷总览</span><small>{{ store.filtered.length }} 项</small></RouterLink>
        <RouterLink to="/track"><span>里程与区段</span><small>Canvas</small></RouterLink>
        <RouterLink to="/work-orders"><span>整治复测</span><small>{{ store.defects.filter((item) => item.status !== '已关闭').length }} 项</small></RouterLink>
        <RouterLink to="/sync"><span>离线回传</span><small>{{ store.pendingOps.length }} 待传 · {{ store.openConflicts.length }} 待复核</small></RouterLink>
        <RouterLink to="/audit"><span>审计追溯</span><small>{{ store.audit.length }} 条</small></RouterLink>
      </nav>
      <div class="aside-data"><span>数据接入</span><strong>{{ store.online ? '轨检车数据已导入' : '离线模式：操作暂存本机' }}</strong><small>本地持久化 / 断网可补录，恢复后按版本合并</small></div>
    </aside>
    <v-main class="shell-main">
      <header class="top"><div><span>工务调度中心 / 轨道几何</span><h1>{{ title }}</h1></div><div><small>线别</small><strong>京广上行 / 沪昆下行</strong><v-chip class="net-chip" size="x-small" :color="store.online ? 'success' : 'error'">{{ store.online ? '在线' : '离线' }}</v-chip></div></header>
      <RouterView />
    </v-main>
  </v-app>
</template>
