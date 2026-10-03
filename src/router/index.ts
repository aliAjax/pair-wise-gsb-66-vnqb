import { createRouter, createWebHistory } from 'vue-router'
import DefectListView from '../views/DefectListView.vue'
import TrackDetailView from '../views/TrackDetailView.vue'
import WorkOrderView from '../views/WorkOrderView.vue'
import AuditView from '../views/AuditView.vue'
import SyncView from '../views/SyncView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'defects', component: DefectListView },
    { path: '/track/:id?', name: 'track', component: TrackDetailView, props: true },
    { path: '/work-orders/:id?', name: 'workOrders', component: WorkOrderView, props: true },
    { path: '/sync', name: 'sync', component: SyncView },
    { path: '/audit', name: 'audit', component: AuditView }
  ]
})
