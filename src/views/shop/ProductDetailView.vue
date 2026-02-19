<template>
  <div v-if="product">
    <div class="breadcrumb">
        <span @click="$router.push('/')">首页</span> &gt; 
        <span>{{ product.category }}</span> &gt; 
        <span style="color: var(--text-main); font-weight: bold;">详情</span>
    </div>

    <div class="detail-card">
        <div class="detail-layout">
            <div class="detail-image-box">
                <img :src="product.image" alt="商品主图">
            </div>
            <div class="detail-info">
                <div>
                    <h1 class="detail-title">{{ product.name }}</h1>
                    <p class="detail-desc">{{ product.desc }}</p>
                    <div class="price-box">
                        <span style="font-size: 0.875rem; color: var(--primary-color);">应援价</span>
                        <span class="price-current">¥{{ getDisplayPrice(product) }}</span>
                        <span v-if="hasDiscount(product)" class="price-original">¥{{ product.price }}</span>
                        <span class="tag-stock">现货</span>
                    </div>
                    <!-- [修改] 动态渲染参数表 -->
                    <div style="margin-bottom: 2rem;">
                        <h3 style="font-size: 0.875rem; color: #999; margin-bottom: 0.75rem; text-transform: uppercase;">规格参数</h3>
                        <table class="specs-table" v-if="product.specs && product.specs.length">
                            <tbody>
                                <tr v-for="(spec, idx) in product.specs" :key="idx">
                                    <td>{{ spec.key }}</td>
                                    <td>{{ spec.val }}</td>
                                </tr>
                            </tbody>
                        </table>
                        <p v-else style="font-size: 0.8rem; color: #ccc;">暂无规格参数</p>
                    </div>
                </div>
                <div>
                    <div class="flex-row items-center gap-4 detail-qty-row" style="margin-bottom: 1.5rem;">
                        <span style="font-size: 0.875rem; color: #666;">数量</span>
                        <div class="quantity-control">
                            <button @click="quantity > 1 ? quantity-- : null" class="qty-btn">-</button>
                            <input type="number" v-model="quantity" class="qty-input" readonly>
                            <button @click="quantity++" class="qty-btn">+</button>
                        </div>
                        <span style="font-size: 0.75rem; color: #999;">库存 ({{ product.stock }}件)</span>
                    </div>
                    
                    <div v-if="product.shippingCost > 0" style="margin-bottom: 1rem; font-size: 0.75rem; color: #666;">
                        <i class="fa fa-truck"></i> 基础运费: ¥{{ product.shippingCost }} (同组取最大)
                    </div>

                    <div class="action-row">
                        <button class="market-btn primary action-btn-group" style="padding: 0.75rem;" @click="buyNow">
                            <i class="fa fa-shopping-bag mr-2"></i> 立即购买
                        </button>
                        <button class="market-btn outline-blue action-btn-group" style="padding: 0.75rem;" @click="addToCart">
                            <i class="fa fa-cart-plus mr-2"></i> 加入购物车
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="content-card">
        <div class="tabs-header">
            <div class="tab-item active">商品详情</div>
        </div>
        <div class="tab-content">
            <!-- [修改] 渲染详情文案和详情图 -->
            <div class="detail-text" v-if="product.detailText">
                <p style="white-space: pre-wrap;">{{ product.detailText }}</p>
            </div>
            <div class="detail-images">
                <img v-for="(img, idx) in product.detailImages" :key="idx" :src="img" alt="详情图">
            </div>
            <div v-if="!product.detailText && (!product.detailImages || product.detailImages.length===0)" style="text-align:center; color:#ccc; padding: 2rem;">
                暂无图文详情
            </div>
        </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useShopStore } from '@/stores/shopStore'

const route = useRoute()
const router = useRouter()
const store = useShopStore()
const quantity = ref(1)

// 确保进入详情页时有数据
onMounted(() => {
    if (store.state.products.length === 0) store.fetchProducts()
})

const product = computed(() => store.state.products.find(p => p.id == route.params.id))
const hasDiscount = (item) => store.hasProductDiscount(item)
const getDisplayPrice = (item) => store.resolveProductPrice(item)

const addToCart = () => {
    if(product.value) store.addToCart(product.value, quantity.value)
}

const buyNow = () => {
    addToCart()
    router.push('/cart')
}
</script>

<style scoped>
@media (max-width: 639px) {
    .detail-qty-row {
        flex-wrap: wrap;
        gap: 0.6rem;
        align-items: center;
    }
}
</style>
