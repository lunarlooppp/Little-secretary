import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { MotionPlugin } from '@vueuse/motion';
import App from './App.vue';
import { rippleDirective } from './directives/ripple';
import './styles.css';

const app = createApp(App);

app
  .directive('ripple', rippleDirective)
  .use(createPinia())
  .use(MotionPlugin, {
    directives: {
      button: {
        initial: { scale: 1, y: 0 },
        hovered: { scale: 1.025, y: -1 },
        tapped: { scale: 0.965, y: 1 }
      },
      buttonPrimary: {
        initial: { scale: 1, y: 0 },
        hovered: { scale: 1.03, y: -2 },
        tapped: { scale: 0.96, y: 1 }
      },
      buttonDanger: {
        initial: { scale: 1, rotate: 0 },
        hovered: { scale: 1.055, rotate: -3 },
        tapped: { scale: 0.94, rotate: 3 }
      }
    }
  })
  .mount('#app');
