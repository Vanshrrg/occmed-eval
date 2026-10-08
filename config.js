// ใส่ค่าจาก Supabase: Project Settings → API
// (anon key เปิดเผยได้ ข้อมูลถูกป้องกันด้วยการเข้าสู่ระบบ + Row Level Security)
window.APP_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
  HOSPITAL_NAME: 'โรงพยาบาล...',
  // วันครบกำหนดประเมินมาตรฐานฯ (ปี-เดือน-วัน, ค.ศ.) ใช้แสดงนับถอยหลัง
  P1_DEADLINE: '2027-06-01'
};
