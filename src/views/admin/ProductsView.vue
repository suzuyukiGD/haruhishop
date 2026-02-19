<template>
  <div class="panel">
    <div class="toolbar">
        <h3 style="font-weight: bold; color: #374151; margin: 0;">商品库管理</h3>
        <button class="admin-btn btn-green" @click="openModal()">
            <i class="fa fa-plus"></i> 新增商品
        </button>
    </div>
    <div class="table-container">
        <table class="data-table">
            <thead>
                <tr><th>ID</th><th>图片</th><th>名称</th><th>分类</th><th>价格</th><th>库存</th><th>发货组</th><th>运费</th><th>操作</th></tr>
            </thead>
            <tbody>
                <tr v-for="p in products" :key="p.id">
                    <td class="text-sub">#{{ p.id }}</td>
                    <td><img :src="p.image" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px;"></td>
                    <td style="font-weight: 500;">{{ p.name }}</td>
                    <td><span class="status-badge status-2">{{ p.category }}</span></td>
                    <td>
                        <div style="font-weight: bold;">¥{{ getDisplayPrice(p) }}</div>
                        <div v-if="hasDiscount(p)" class="text-sub" style="text-decoration: line-through;">原价 ¥{{ p.price }}</div>
                    </td>
                    <td :style="{color: p.stock < 10 ? 'red' : 'inherit', fontWeight: 'bold'}">{{ p.stock }}</td>
                    <td class="text-sub">{{ p.shippingTag }}</td>
                    <td class="text-sub">¥{{ p.shippingCost }}</td>
                    <td>
                        <button class="admin-btn btn-blue" style="font-size: 0.75rem; margin-right: 0.5rem;" @click="openModal(p)">编辑</button>
                        <button class="admin-btn btn-outline" style="font-size: 0.75rem; color: #ef4444; border-color: #fca5a5;" @click="store.deleteProduct(p.id)">删除</button>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>

    <!-- 编辑/新增 弹窗 (大) -->
    <div v-if="showModal" class="modal-overlay">
        <div class="modal-card product-modal-card">
            <h3 class="modal-title">{{ isEdit ? '编辑商品' : '新增商品' }}</h3>
            <div class="form-grid product-form-grid">
                
                <!-- 第一行：基础信息 -->
                <div><label class="form-label">名称</label><input v-model="form.name" class="form-input"></div>
                <div><label class="form-label">分类名</label><input v-model="form.category" class="form-input" placeholder="如: 立牌、卡贴、折扇"></div>
                <div>
                    <label class="form-label">发货标签 (分组)</label>
                    <select v-model="form.shippingTag" class="form-select">
                        <option value="深圳">深圳</option>
                        <option value="上海">上海</option>
                        <option value="柔造">柔造</option>
                        <option value="蚌埠">蚌埠</option>
                    </select>
                </div>

                <!-- 第二行：价格库存 -->
                <div><label class="form-label">价格 (¥)</label><input v-model.number="form.price" class="form-input" type="number"></div>
                <div><label class="form-label">折扣价 (¥)</label><input v-model="form.discountPrice" class="form-input" type="number" min="0" step="0.01" placeholder="留空表示不打折"></div>
                <div><label class="form-label">库存</label><input v-model.number="form.stock" class="form-input" type="number"></div>
                
                <!-- 第三行：运费 -->
                <div><label class="form-label">单品运费 (¥)</label><input v-model.number="form.shippingCost" class="form-input" type="number"></div>

                <!-- 第四行：主图上传 -->
                <div class="full-span">
                    <label class="form-label">商品主图</label>
                    <div class="main-image-row">
                        <img v-if="form.image" :src="form.image" style="width: 60px; height: 60px; object-fit: cover; border: 1px solid #ddd; border-radius: 4px;">
                        <input type="file" @change="e => handleUpload(e, 'image')" accept="image/*">
                    </div>
                </div>

                <!-- 第五行：描述 -->
                <div class="full-span">
                    <label class="form-label">短描述 (列表页显示)</label>
                    <input v-model="form.desc" class="form-input">
                </div>

                <!-- 第六行：参数表 (Key-Value 编辑) -->
                <div class="full-span" style="background: #f9fafb; padding: 1rem; border-radius: 8px;">
                    <label class="form-label" style="font-weight: bold;">规格参数表</label>
                    <div v-for="(spec, idx) in form.specs" :key="idx" style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem;">
                        <input v-model="spec.key" placeholder="参数名" class="form-input" style="flex:1; margin:0;">
                        <input v-model="spec.val" placeholder="参数值" class="form-input" style="flex:2; margin:0;">
                        <button @click="removeSpec(idx)" class="admin-btn btn-outline" style="color: red; padding: 0 0.5rem;">×</button>
                    </div>
                    <button @click="addSpec" class="admin-btn btn-outline" style="font-size: 0.75rem;">+ 添加参数</button>
                </div>

                <!-- 第七行：详情页文案 -->
                <div class="full-span">
                    <label class="form-label">详情页长文案</label>
                    <textarea v-model="form.detailText" class="form-input" style="height: 100px;"></textarea>
                </div>

                <!-- 第八行：详情多图上传 -->
                <div class="full-span">
                    <label class="form-label">详情页图片组</label>
                    <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem;">
                        <div v-for="(img, idx) in form.detailImages" :key="idx" style="position: relative;">
                            <img :src="img" style="width: 80px; height: 80px; object-fit: cover; border: 1px solid #ddd;">
                            <button @click="removeDetailImg(idx)" style="position: absolute; top:0; right:0; background: red; color: white; border: none; width: 20px; height: 20px; cursor: pointer;">×</button>
                        </div>
                    </div>
                    <input type="file" @change="e => handleUpload(e, 'detail')" accept="image/*">
                </div>

            </div>
            <div class="modal-actions">
                <button @click="showModal = false" class="admin-btn btn-outline">取消</button>
                <button @click="save" class="admin-btn btn-blue">保存</button>
            </div>
        </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive } from 'vue'
import { useShopStore } from '@/stores/shopStore'

const store = useShopStore()
const products = computed(() => store.state.products)
const showModal = ref(false)
const isEdit = ref(false)

// 表单初始状态
const initialForm = {
    id: null, name: '', price: 0, category: '', stock: 100,
    discountPrice: '',
    image: '', desc: '',
    specs: [], detailText: '', detailImages: [],
    shippingTag: '深圳', shippingCost: 0
}

const form = reactive({ ...initialForm })

onMounted(() => { store.fetchProducts() })

const openModal = (product = null) => {
    if (product) {
        isEdit.value = true
        // 深度拷贝以避免引用问题，特别是数组
        const p = JSON.parse(JSON.stringify(product))
        Object.assign(form, p)
        form.discountPrice = p.discountPrice ?? ''
        // 确保数组存在
        if (!form.specs) form.specs = []
        if (!form.detailImages) form.detailImages = []
    } else {
        isEdit.value = false
        Object.assign(form, JSON.parse(JSON.stringify(initialForm)))
    }
    showModal.value = true
}

const handleUpload = async (e, type) => {
    const file = e.target.files[0]
    if (!file) return
    const url = await store.uploadImage(file)
    if (url) {
        if (type === 'image') {
            form.image = url
        } else {
            form.detailImages.push(url)
        }
    }
    e.target.value = '' // reset input
}

const addSpec = () => form.specs.push({ key: '', val: '' })
const removeSpec = (idx) => form.specs.splice(idx, 1)
const removeDetailImg = (idx) => form.detailImages.splice(idx, 1)

const hasDiscount = (product) => {
    const base = Number(product?.price)
    const discount = Number(product?.discountPrice)
    return Number.isFinite(discount) && discount > 0 && (!Number.isFinite(base) || discount < base)
}

const getDisplayPrice = (product) => (hasDiscount(product) ? Number(product.discountPrice) : Number(product.price))

const save = async () => {
    const payload = { ...form }
    if (payload.discountPrice === '' || payload.discountPrice === null || payload.discountPrice === undefined) {
        payload.discountPrice = null
    } else {
        payload.discountPrice = Number(payload.discountPrice)
    }

    if (payload.discountPrice !== null) {
        if (!Number.isFinite(payload.discountPrice) || payload.discountPrice <= 0) {
            store.showNotification('折扣价必须大于0')
            return
        }
        if (payload.discountPrice >= Number(payload.price)) {
            store.showNotification('折扣价需小于原价')
            return
        }
    }

    let success = false
    if (isEdit.value) {
        success = await store.updateProduct(form.id, payload)
    } else {
        success = await store.addProduct(payload)
    }
    if (success) showModal.value = false
}
</script>

<style scoped>
.form-grid { display: grid; }
.product-modal-card {
    width: min(960px, 94vw);
    max-height: 90vh;
    overflow-y: auto;
}
.product-form-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
}
.full-span {
    grid-column: 1 / -1;
}
.main-image-row {
    display: flex;
    gap: 1rem;
    align-items: center;
}

@media (max-width: 1023px) {
    .product-form-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 639px) {
    .product-form-grid {
        grid-template-columns: 1fr;
        gap: 0.75rem;
    }
    .main-image-row {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.5rem;
    }
}
</style>
