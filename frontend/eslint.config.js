import pluginVue from 'eslint-plugin-vue'

export default [
  ...pluginVue.configs['flat/vue3-recommended'],
  {
    rules: {
      'vue/no-multiple-template-root': 'off',
    },
  },
]
