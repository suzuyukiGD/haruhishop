<template>
  <div class="panel">
    <div class="toolbar">
      <div class="filter-group">
        <button
          v-for="status in statusOptions"
          :key="status.value"
          class="filter-btn"
          :class="{ active: filterStatus === status.value }"
          @click="changeFilter(status.value)"
        >
          {{ status.label }}
        </button>
      </div>
      <div class="toolbar-query">
        <input v-model.trim="keyword" class="search-input" placeholder="按订单号/收货人/手机号搜索">
        <select v-model="sortBy" class="form-select compact-select">
          <option value="created_at">按时间</option>
          <option value="total">按金额</option>
          <option value="status">按状态</option>
          <option value="id">按订单号</option>
        </select>
        <select v-model="sortDir" class="form-select compact-select">
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
        <select v-model.number="pageSize" class="form-select compact-select">
          <option :value="10">10/页</option>
          <option :value="20">20/页</option>
          <option :value="50">50/页</option>
        </select>
        <button class="admin-btn btn-blue" @click="searchOrders">查询</button>
      </div>
      <div class="toolbar-actions">
        <span class="text-sub">已选 {{ selectedCount }} 单</span>
        <button class="admin-btn btn-outline" :disabled="selectedCount === 0" @click="clearSelection">清空选择</button>
        <button class="admin-btn btn-green" :disabled="selectedCount === 0" @click="exportSelectedOrders">
          <i class="fa fa-download"></i> 导出所选
        </button>
      </div>
    </div>

    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th class="checkbox-cell">
              <input
                ref="selectAllRef"
                type="checkbox"
                :checked="allSelected"
                :disabled="orders.length === 0"
                @change="toggleSelectAll($event.target.checked)"
              >
            </th>
            <th>订单号 / 时间</th>
            <th>商品概览</th>
            <th>收货信息</th>
            <th>金额</th>
            <th style="text-align: center;">状态</th>
            <th style="text-align: center;">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="order in orders" :key="order.id">
            <td class="checkbox-cell">
              <input type="checkbox" :checked="isOrderSelected(order.id)" @change="toggleSelectOrder(order.id, $event.target.checked)">
            </td>
            <td>
              <div class="order-id">{{ order.id }}</div>
              <div class="text-sub">{{ new Date(order.created_at).toLocaleString() }}</div>
            </td>
            <td>
              <div v-for="(item, idx) in order.items" :key="idx" class="item-row">
                {{ item.name }} <span style="color: #9ca3af;">x{{ item.quantity }}</span>
              </div>
            </td>
            <td style="font-size: 0.85rem;">
              <div><strong>{{ order.contact.name }}</strong> {{ order.contact.phone }}</div>
              <div class="text-sub">{{ order.contact.province }}{{ order.contact.city }}{{ order.contact.district }}</div>
              <div class="text-sub" style="max-width: 200px;">{{ order.contact.addressDetail }}</div>
            </td>
            <td style="font-weight: bold;">¥{{ order.total }}</td>
            <td style="text-align: center;">
              <span :class="['status-badge', 'status-' + order.status]">{{ getStatusLabel(order.status) }}</span>
            </td>
            <td style="text-align: center;">
              <div style="display: flex; gap: 0.5rem; justify-content: center;">
                <template v-if="order.status === 1">
                  <button class="admin-btn btn-blue" style="font-size: 0.75rem;" @click="updateStatus(order.id, 2)">收款</button>
                  <button class="admin-btn btn-outline" style="font-size: 0.75rem; color: #ef4444;" @click="updateStatus(order.id, 0)">取消</button>
                </template>
                <template v-if="order.status === 5">
                  <button class="admin-btn btn-blue" style="font-size: 0.75rem;" @click="updateStatus(order.id, 2)">确认收款</button>
                  <button class="admin-btn btn-outline order-delete-btn" style="font-size: 0.75rem;" @click="deletePendingOrder(order)">删除</button>
                </template>
                <template v-if="order.status === 2">
                  <button class="admin-btn btn-green" style="font-size: 0.75rem;" @click="openShip(order)">发货</button>
                </template>
                <span v-if="order.status === 0" style="color: #999; font-size: 0.75rem;">已取消 (库存已回滚)</span>
                <span v-if="order.status === 3" style="color: #10b981; font-size: 0.75rem;">已发货</span>
              </div>
            </td>
          </tr>
          <tr v-if="orders.length === 0">
            <td colspan="7" style="text-align: center; color: #9ca3af;">暂无订单数据</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="toolbar pagination-row">
      <span class="text-sub">共 {{ ordersMeta.total }} 单，第 {{ ordersMeta.page }} / {{ ordersMeta.totalPages }} 页</span>
      <button class="admin-btn btn-outline" :disabled="ordersMeta.page <= 1" @click="goPrevPage">上一页</button>
      <button class="admin-btn btn-outline" :disabled="ordersMeta.page >= ordersMeta.totalPages" @click="goNextPage">下一页</button>
    </div>

    <div v-if="shipModal.show" class="modal-overlay">
      <div class="modal-card">
        <h3 class="modal-title">订单发货</h3>
        <label class="form-label">快递单号 (选填，可自动识别快递公司)</label>
        <input v-model="shipModal.no" type="text" class="form-input" placeholder="留空则不回填运单号">
        <div v-if="detectedCompany" style="margin-top: 0.5rem; font-size: 0.85rem; color: #047857;">
          <i class="fa fa-check-circle"></i> 识别为: {{ detectedCompany }}
        </div>
        <div class="modal-actions">
          <button @click="shipModal.show = false" class="admin-btn btn-outline">取消</button>
          <button @click="confirmShip" class="admin-btn btn-blue">确认发货</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive, watch } from 'vue'
import { useShopStore } from '@/stores/shopStore'

const store = useShopStore()
const filterStatus = ref('all')
const orders = computed(() => store.state.adminOrders)
const ordersMeta = computed(() => store.state.adminOrdersMeta || { page: 1, pageSize: 20, total: 0, totalPages: 1 })
const selectedOrderIds = ref(new Set())
const selectAllRef = ref(null)
const keyword = ref('')
const sortBy = ref('created_at')
const sortDir = ref('desc')
const pageSize = ref(20)

const statusOptions = [
  { value: 'all', label: '全部' },
  { value: 1, label: '待付款' },
  { value: 5, label: '待确认' },
  { value: 2, label: '待发货' },
  { value: 3, label: '已发货' },
  { value: 0, label: '已取消' }
]

const selectedOrders = computed(() => orders.value.filter((order) => selectedOrderIds.value.has(order.id)))
const selectedCount = computed(() => selectedOrders.value.length)
const allSelected = computed(() => orders.value.length > 0 && selectedCount.value === orders.value.length)
const partiallySelected = computed(() => selectedCount.value > 0 && selectedCount.value < orders.value.length)

const clearSelection = () => {
  selectedOrderIds.value = new Set()
}

const isOrderSelected = (orderId) => selectedOrderIds.value.has(orderId)

const toggleSelectOrder = (orderId, checked) => {
  const next = new Set(selectedOrderIds.value)
  if (checked) next.add(orderId)
  else next.delete(orderId)
  selectedOrderIds.value = next
}

const toggleSelectAll = (checked) => {
  if (!checked) {
    clearSelection()
    return
  }
  selectedOrderIds.value = new Set(orders.value.map((order) => order.id))
}

const buildListFilters = (pageOverride = null) => ({
  keyword: keyword.value,
  sortBy: sortBy.value,
  sortDir: sortDir.value,
  page: pageOverride ?? ordersMeta.value.page ?? 1,
  pageSize: pageSize.value
})

const loadOrders = async (page = 1) => {
  clearSelection()
  await store.fetchAdminOrders(filterStatus.value, buildListFilters(page))
}

const changeFilter = (status) => {
  filterStatus.value = status
  loadOrders(1)
}

onMounted(() => {
  loadOrders(1)
})

const searchOrders = () => {
  loadOrders(1)
}

const goPrevPage = () => {
  if (ordersMeta.value.page <= 1) return
  loadOrders(ordersMeta.value.page - 1)
}

const goNextPage = () => {
  if (ordersMeta.value.page >= ordersMeta.value.totalPages) return
  loadOrders(ordersMeta.value.page + 1)
}

const getStatusLabel = (s) => (['已取消', '待付款', '待发货', '已发货', '已完成', '待确认'][s] || '未知')

const updateStatus = async (id, status) => {
  if (status === 0 && !confirm('取消订单将自动回滚库存，确定吗？')) return
  await store.updateOrderStatus(id, status, {}, filterStatus.value, buildListFilters())
}

const deletePendingOrder = async (order) => {
  if (!order || order.status !== 5) return
  const shouldDelete = confirm(`确认删除订单 ${order.id}？该操作将回滚库存，仅用于清理异常或测试订单。`)
  if (!shouldDelete) return
  await store.deleteAdminOrder(order.id, filterStatus.value, buildListFilters())
}

watch([orders, partiallySelected], () => {
  if (selectAllRef.value) {
    selectAllRef.value.indeterminate = partiallySelected.value
  }
}, { immediate: true })

watch(orders, (currentOrders) => {
  const visibleIds = new Set(currentOrders.map((order) => order.id))
  const next = new Set()
  selectedOrderIds.value.forEach((id) => {
    if (visibleIds.has(id)) next.add(id)
  })
  selectedOrderIds.value = next
})

const shipModal = reactive({ show: false, id: null, no: '' })
const openShip = (order) => {
  shipModal.no = ''
  shipModal.id = order.id
  shipModal.show = true
}

const detectCompany = (no) => {
  if (!no) return ''
  const n = no.trim().toUpperCase()
  if (n.startsWith('SF')) return '顺丰速运'
  if (n.startsWith('YT')) return '圆通速递'
  if (n.startsWith('JT')) return '极兔速递'
  if (n.startsWith('JD')) return '京东快递'
  if (/^E[A-Z]\d/.test(n)) return 'EMS'
  if (/^46\d/.test(n)) return '韵达快递'
  if (/^77\d/.test(n)) return '申通快递'
  if (/^7[56]\d/.test(n)) return '中通快递'
  if (/^(268|368|468|568)\d/.test(n)) return '申通快递'
  if (/^(31|32|33|34)\d/.test(n)) return '韵达快递'
  if (/^(70|56)\d/.test(n)) return '百世快递'
  return '未知快递'
}

const detectedCompany = computed(() => detectCompany(shipModal.no))

const confirmShip = async () => {
  const no = shipModal.no.trim()
  const tracking = no ? { trackingCompany: detectCompany(no), trackingNo: no } : {}
  const success = await store.updateOrderStatus(shipModal.id, 3, tracking, filterStatus.value, buildListFilters())
  if (success) shipModal.show = false
}

const toCsvCell = (value) => {
  if (value === null || value === undefined) return ''
  const text = String(value).replace(/"/g, '""')
  return /[",\n]/.test(text) ? `"${text}"` : text
}

const toAddressText = (contact = {}) => `${contact.province || ''}${contact.city || ''}${contact.district || ''}${contact.addressDetail || ''}`
const toItemsText = (items = []) => items.map((item) => `${item.name} x${item.quantity}`).join('；')

const exportSelectedOrders = () => {
  if (selectedCount.value === 0) {
    alert('请先选择要导出的订单')
    return
  }

  const headers = ['订单号', '下单时间', '状态', '金额', '收货人', '联系电话', '邮箱', '收货地址', '商品明细', '物流公司', '物流单号']
  const rows = selectedOrders.value.map((order) => [
    order.id,
    new Date(order.created_at).toLocaleString(),
    getStatusLabel(order.status),
    order.total,
    order.contact?.name || '',
    order.contact?.phone || '',
    order.contact?.email || '',
    toAddressText(order.contact),
    toItemsText(order.items),
    order.trackingCompany || '',
    order.trackingNo || ''
  ])

  const csv = [
    headers.map(toCsvCell).join(','),
    ...rows.map((row) => row.map(toCsvCell).join(','))
  ].join('\n')

  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `orders-${stamp}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
</script>

<style scoped>
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.toolbar-query {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.pagination-row {
  justify-content: flex-end;
  gap: 0.5rem;
}

.checkbox-cell {
  width: 3rem;
  text-align: center;
}

.compact-select {
  width: 110px;
  margin-bottom: 0;
  padding: 0.35rem 0.5rem;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.order-delete-btn {
  color: #ef4444;
  border-color: #fca5a5;
}
</style>
